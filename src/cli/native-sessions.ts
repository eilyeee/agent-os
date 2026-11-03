/**
 * 读取执行引擎自己保存的历史会话。
 * 飞书话题只保存当前选中的 cliSessionId，完整列表始终由引擎管理，
 * 因此你在终端里创建的会话也能出现在 /resume 卡片中。
 */
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { AGENT_OS_PROMPT_MARKER } from "../core/bot-registry.js";
import type { CliAdapter, CliSessionSummary } from "./types.js";
import { killCli, spawnCli } from "./spawn-cli.js";

const SESSION_LIMIT = 8; // 条：恢复卡片保持可扫描，来源过滤必须发生在这个限量之前。
const REQUEST_TIMEOUT_MS = 15_000; // 毫秒：所有分页共用时限，不能每翻一页重新计时。

export interface ListNativeCliSessionsOptions {
  adapter: CliAdapter;
  cwd: string;
  scope?: "agent-os" | "workspace";
}

const JsonMessageSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string().optional() }).optional(),
});
type JsonMessage = z.infer<typeof JsonMessageSchema>;

const ThreadListResultSchema = z.object({
  data: z.array(z.unknown()),
  nextCursor: z.string().nullish(),
});
const ThreadSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().nullish(),
  preview: z.string(),
  updatedAt: z.number().int().refine((seconds) => Number.isFinite(new Date(seconds * 1000).getTime())),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function shortText(value: unknown, maxLength = 80): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function userPrompt(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  if (typeof message.content === "string") return shortText(message.content);
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter(isRecord)
    .filter((block) => block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join(" ");
  return shortText(text);
}

/** Claude Code 按工作目录分目录存放会话，目录名是路径的非字母数字全替换成连字符。 */
function claudeProjectDirectory(configDir: string, cwd: string): string {
  return join(configDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

async function readClaudeSession(
  filePath: string,
  expectedCwd: string,
): Promise<CliSessionSummary | undefined> {
  const lines = createInterface({ input: createReadStream(filePath) });
  let sessionId: string | undefined;
  let observedCwd: string | undefined;
  let firstPrompt: string | undefined;
  let lastPrompt: string | undefined;
  let title: string | undefined;

  for await (const line of lines) {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(row)) continue;
    if (typeof row.sessionId === "string") sessionId = row.sessionId;
    if (typeof row.cwd === "string") observedCwd = row.cwd;
    if (row.type === "ai-title") title = shortText(row.aiTitle) ?? title;
    if (row.type === "last-prompt") {
      lastPrompt = shortText(row.lastPrompt) ?? lastPrompt;
    }
    if (row.type === "user" && !firstPrompt) firstPrompt = userPrompt(row.message);
  }

  if (!sessionId || observedCwd !== expectedCwd) return undefined;
  const metadata = await stat(filePath);
  return {
    id: sessionId,
    title: title ?? lastPrompt ?? firstPrompt ?? "未命名会话",
    updatedAt: metadata.mtime.toISOString(),
    // 首条用户消息带角色前缀的，才是 Agent OS 派发的。
    origin: firstPrompt?.startsWith(AGENT_OS_PROMPT_MARKER)
      ? "agent-os"
      : "external",
  };
}

async function listClaudeSessions(
  options: ListNativeCliSessionsOptions,
): Promise<CliSessionSummary[]> {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const projectDir = claudeProjectDirectory(configDir, options.cwd);
  let names: string[];
  try {
    names = await readdir(projectDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const sessions = await Promise.all(
    names
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) =>
        readClaudeSession(join(projectDir, name), options.cwd).catch(
          () => undefined,
        ),
      ),
  );
  const ordered = sessions
    .filter((session): session is CliSessionSummary => session !== undefined)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return filterResumableSessions(ordered, options.scope ?? "agent-os").slice(0, SESSION_LIMIT);
}

function protocolError(message: JsonMessage): string | undefined {
  if (!isRecord(message.error)) return undefined;
  return typeof message.error.message === "string"
    ? message.error.message
    : "Codex 会话列表读取失败";
}

/** Codex 通过 app-server 的 JSON-RPC 暴露历史会话，用 cwd 精确过滤。 */
function listCodexSessions(
  options: ListNativeCliSessionsOptions,
): Promise<CliSessionSummary[]> {
  return new Promise((resolve, reject) => {
    const child = spawnCli(options.adapter.command, ["app-server", "--stdio"], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    let stderr = "";
    let settled = false;
    let initialized = false;
    let nextRequestId = 2; // initialize 使用 1；每页独立 ID，迟到的旧响应不能混入新页。
    let pendingListId: number | undefined;
    const sessions: CliSessionSummary[] = [];
    const sessionIds = new Set<string>();
    const seenCursors = new Set<string>();

    // app-server 提前退出时 send() 会打到断掉的管道上，未监听的 EPIPE 会杀掉整个进程。
    child.stdin.on("error", (error: Error) => fail(error));
    const send = (message: Record<string, unknown>) => {
      if (child.stdin.destroyed || !child.stdin.writable) return;
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const cleanup = () => {
      clearTimeout(timer);
      lines.close();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      killCli(child);
      reject(error);
    };
    const succeed = (sessions: CliSessionSummary[]) => {
      if (settled) return;
      settled = true;
      cleanup();
      killCli(child);
      resolve(sessions);
    };
    const timer = setTimeout(
      () => fail(new Error("Codex 会话列表读取超时")),
      REQUEST_TIMEOUT_MS,
    );
    const requestPage = (cursor?: string) => {
      pendingListId = nextRequestId++;
      send({
        id: pendingListId,
        method: "thread/list",
        params: {
          cwd: options.cwd,
          limit: SESSION_LIMIT,
          sortKey: "updated_at",
          sortDirection: "desc",
          sourceKinds: ["cli", "vscode", "exec", "appServer"],
          ...(cursor !== undefined ? { cursor } : {}),
        },
      });
    };

    lines.on("line", (line: string) => {
      if (settled) return;
      let message: JsonMessage;
      try {
        const parsed = JsonMessageSchema.safeParse(JSON.parse(line));
        if (!parsed.success) return;
        message = parsed.data;
      } catch {
        return;
      }
      if (message.id !== 1 && (pendingListId === undefined || message.id !== pendingListId)) return;
      const error = protocolError(message);
      if (error) return fail(new Error(error));

      if (message.id === 1) {
        if (initialized) return;
        initialized = true;
        send({ method: "initialized", params: {} });
        requestPage();
        return;
      }
      if (pendingListId === undefined || message.id !== pendingListId) return;
      pendingListId = undefined;
      const page = ThreadListResultSchema.safeParse(message.result);
      if (!page.success) return fail(new Error("Codex 会话列表格式有误，请更新引擎后重试。"));

      for (const row of page.data.data) {
        const parsed = ThreadSummarySchema.safeParse(row);
        if (!parsed.success) continue;
        const thread = parsed.data;
        const session: CliSessionSummary = {
          id: thread.id,
          title: shortText(thread.name) ?? shortText(thread.preview) ?? "未命名会话",
          updatedAt: new Date(thread.updatedAt * 1000).toISOString(),
          origin: thread.preview.startsWith(AGENT_OS_PROMPT_MARKER) ? "agent-os" : "external",
        };
        if (filterResumableSessions([session], options.scope ?? "agent-os").length && !sessionIds.has(session.id)) {
          sessions.push(session);
          sessionIds.add(session.id);
        }
        if (sessions.length === SESSION_LIMIT) return succeed(sessions);
      }
      // Codex 的 nextCursor 是不透明字符串；只有取够合格会话或没有下一页才结束。
      const cursor = page.data.nextCursor;
      if (cursor === undefined || cursor === null) return succeed(sessions);
      if (seenCursors.has(cursor)) {
        return fail(new Error("Codex 会话列表返回了重复分页游标，请更新引擎后重试。"));
      }
      seenCursors.add(cursor);
      requestPage(cursor);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once("error", (error: Error) => fail(error));
    child.once("close", (code: number | null) => {
      if (settled) return;
      fail(new Error(stderr.trim() || `Codex app-server 提前退出，状态码 ${code}`));
    });

    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "agent_os", title: "Agent OS", version: "0.1.0" },
      },
    });
  });
}

export function listNativeCliSessions(
  options: ListNativeCliSessionsOptions,
): Promise<CliSessionSummary[]> {
  return options.adapter.id === "claude"
    ? listClaudeSessions(options)
    : listCodexSessions(options);
}

/**
 * 按 resumeScope 过滤可恢复的会话。
 * 默认只留 Agent OS 自己派发过的：人在终端里开的会话可能带着完全无关、甚至敏感的
 * 上下文，而群里任何人都能点「恢复」把它接着跑下去，引擎还是无人值守参数。
 */
export function filterResumableSessions(
  sessions: CliSessionSummary[],
  scope: "agent-os" | "workspace",
): CliSessionSummary[] {
  return scope === "workspace"
    ? sessions
    : sessions.filter((session) => session.origin === "agent-os");
}
