/** 会话元数据落盘。崩溃安全的写入 + 旧数据迁移。 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { Session } from "./session-manager.js";

export interface SessionStore {
  load(): Promise<Session[]>;
  save(sessions: Session[]): Promise<void>;
}

const SessionSchema = z.object({
  id: z.string().min(1),
  botId: z.string().min(1),
  threadId: z.string().min(1),
  chatId: z.string().min(1),
  // 只扩展取值，不改写已有 claude/codex 标识；原生会话 ID 不能跨引擎迁移。
  cliId: z.enum(["claude", "codex", "dsh"]),
  cliSessionId: z.string().min(1).optional(),
  /**
   * 这个话题是由哪条定时任务开出来的。挂在**会话**上而不是挂在某一轮上：
   * 一个定时话题会跑很多轮（首轮、审批拍板后的续跑、澄清答完的续跑、交接回来的那轮），
   * 挂在轮上就得在每个 runCliTurn 调用点各挂一次，漏一个就是一个中止不到的洞。
   * 老会话没有这个字段，读出来是 undefined，不影响。
   */
  scheduleId: z.string().min(1).optional(),
  workspaceDir: z.string().min(1),
  status: z.enum(["creating", "active", "idle", "closed"]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 给旧记录补齐后来新增的字段。
 * 直接收紧 Schema 会把用户已有会话全部判成无效数据，必须先迁移再校验。
 */
function migrateLegacySession(
  row: unknown,
  legacyBotId: string,
  defaultWorkspaces: Readonly<Record<string, string>>,
): { candidate: unknown; migrated: boolean } {
  if (!isRecord(row)) return { candidate: row, migrated: false };

  const needsBotId = !("botId" in row);
  const needsWorkspace = !("workspaceDir" in row);
  if (!needsBotId && !needsWorkspace) return { candidate: row, migrated: false };

  const candidate: Record<string, unknown> = { ...row };
  if (needsBotId) candidate.botId = legacyBotId;
  const botId =
    typeof candidate.botId === "string" ? candidate.botId : legacyBotId;
  if (needsWorkspace) {
    candidate.workspaceDir = defaultWorkspaces[botId] ?? process.cwd();
  }
  return { candidate, migrated: true };
}

/**
 * 会话保留上限。
 *
 * 每开一个话题就是一条会话，定时任务每次触发也开一个新话题——只涨不减。
 * 涨上去之后：/resume 的列表越来越长、启动恢复越来越慢，
 * 而每次状态变更都要把整份 sessions.json 重写一遍。
 *
 * 丢掉一条旧会话**不会**让引擎上下文变得不可达：/resume 读的是引擎自己的
 * 会话库（~/.claude/…），不是这个文件。丢掉的只是「这个话题自动接哪个 CLI 会话」
 * 这层绑定——在那个旧话题里再发消息会开一个新上下文，想接回旧的用 /resume 就行。
 */
export const SESSION_CAPACITY = 500;

/**
 * 只在**加载时**裁剪，不在运行时裁：加载那一刻没有任何任务在跑，
 * 丢弃是安全的；运行时去猜「这条会不会正被用着」，猜错就是把活着的会话抽掉。
 * 代价是一个连续跑几个月不重启的进程仍会涨——那时候该做的是定期重启，
 * 而不是让裁剪去冒运行时的风险。
 *
 * 丢最久没动过的。closed 的排在前面丢：它已经明确结束了，
 * 而 idle 的还可能被同话题的下一条消息接上。
 */
export function pruneSessions(sessions: Session[]): Session[] {
  if (sessions.length <= SESSION_CAPACITY) return sessions;
  const ranked = [...sessions].sort((a, b) => {
    // closed 排前面（前面 = 先丢）。写成 a - b 的话方向正好反过来，
    // 变成「优先保留已关闭的」——测试当场逮到了。
    const closedFirst =
      Number(b.status === "closed") - Number(a.status === "closed");
    if (closedFirst !== 0) return closedFirst;
    return Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
  });
  // ranked 的开头是「最该丢的」：先 closed 后 idle，同类里最久没动的在前。
  const dropped = new Set(
    ranked.slice(0, sessions.length - SESSION_CAPACITY).map((s) => s.id),
  );
  // 原顺序保留，别把文件里的排列打乱——那会让 diff 变得没法读。
  return sessions.filter((session) => !dropped.has(session.id));
}

/** 上次退出时仍在执行的会话，原进程已经不在了，恢复成空闲。 */
function recoverInterruptedSession(session: Session): Session {
  if (session.status !== "creating" && session.status !== "active") {
    return session;
  }
  return { ...session, status: "idle" };
}

export class JsonSessionStore implements SessionStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly legacyBotId = "default",
    private readonly defaultWorkspaces: Readonly<Record<string, string>> = {},
  ) {}

  async load(): Promise<Session[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const rows: unknown = JSON.parse(content);
    if (!Array.isArray(rows)) {
      throw new Error(`会话文件格式错误: ${this.filePath}`);
    }

    const sessions: Session[] = [];
    let needsCleanup = false;
    for (const row of rows) {
      const { candidate, migrated } = migrateLegacySession(
        row,
        this.legacyBotId,
        this.defaultWorkspaces,
      );
      const result = SessionSchema.safeParse(candidate);
      if (!result.success) {
        needsCleanup = true;
        continue;
      }
      if (migrated) needsCleanup = true;
      const recovered = recoverInterruptedSession(result.data as Session);
      if (recovered.status !== result.data.status) needsCleanup = true;
      sessions.push(recovered);
    }
    const kept = pruneSessions(sessions);
    if (kept.length !== sessions.length) {
      console.warn(
        `[会话] 超出保留上限，丢掉最久没动过的 ${sessions.length - kept.length} 条（保留 ${SESSION_CAPACITY} 条）`,
      );
      needsCleanup = true;
    }
    if (needsCleanup) await this.save(kept);
    return kept;
  }

  save(sessions: Session[]): Promise<void> {
    const snapshot = JSON.stringify(sessions, null, 2);
    const write = async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      // 先写临时文件再 rename 替换，避免进程恰好在写到一半时留下半截 JSON。
      const tempPath = `${this.filePath}.tmp`;
      await writeFile(tempPath, `${snapshot}\n`, "utf8");
      await rename(tempPath, this.filePath);
    };
    // 并发对同一文件调 writeFile 并不安全，用队列让快照按顺序落盘。
    this.writeQueue = this.writeQueue.then(write, write);
    return this.writeQueue;
  }
}
