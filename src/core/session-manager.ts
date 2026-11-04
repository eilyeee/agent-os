/** 会话模型与状态机。一个飞书话题对应一个 Session。 */
import { randomUUID } from "node:crypto";
import type { CliId } from "../cli/types.js";
import type { SessionStore } from "./session-store.js";
import { topicIdOf, type TopicAddress } from "./topic-task.js";

export type SessionStatus = "creating" | "active" | "idle" | "closed";

export interface Session {
  /** Agent OS 自己的会话 ID，管消息路由和任务状态。 */
  id: string;
  botId: string;
  threadId: string;
  chatId: string;
  cliId: CliId;
  /** 执行引擎的会话 ID，管模型对话上下文。两层会话不能混为一谈。 */
  cliSessionId?: string;
  /**
   * 这个话题由哪条定时任务开出来。挂在会话上而不是挂在某一轮上：
   * 一个定时话题会跑很多轮（首轮、审批拍板后续跑、澄清答完续跑、交接回来那轮），
   * 挂在轮上就得在每个 runCliTurn 调用点各挂一次，漏一个就是一个中止不到的洞。
   */
  scheduleId?: string;
  workspaceDir: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

export type MessageAddress = TopicAddress;

export interface ResolvedSession {
  session: Session;
  isNew: boolean;
}

export interface SessionManagerOptions {
  now?: () => Date;
  createId?: () => string;
  store?: SessionStore;
}

/**
 * creating → idle 这条边，是为了让「新话题里第一条就是 /cd、/help」这类
 * 会创建会话但不启动 CLI 的命令不会把会话卡在创建中。
 */
const ALLOWED_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  creating: ["active", "idle", "closed"],
  active: ["idle", "closed"],
  idle: ["active", "closed"],
  closed: [],
};

function sessionKey(botId: string, chatId: string, threadId: string): string {
  // botId 参与计算：同一话题里的两台 bot 拥有各自独立的会话。
  return `${botId}:${chatId}:${threadId}`;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly store: SessionStore | undefined;
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private readonly pendingUpdates = new Map<string, number>();

  constructor(options: SessionManagerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.store = options.store;
  }

  static async open(options: SessionManagerOptions = {}): Promise<SessionManager> {
    const manager = new SessionManager(options);
    const restored = (await options.store?.load()) ?? [];
    for (const session of restored) {
      manager.sessions.set(sessionKey(session.botId, session.chatId, session.threadId), session);
    }
    return manager;
  }

  get size(): number { return this.sessions.size; }

  get(sessionId: string): Session | undefined {
    return [...this.sessions.values()].find(session => session.id === sessionId);
  }

  /** 绑定尚在提交时，应用层不能拿旧目录或旧原生标识启动一轮执行。 */
  isUpdating(sessionId: string): boolean {
    return this.pendingUpdates.has(sessionId);
  }

  async resolve(
    message: MessageAddress,
    cliId: CliId = "claude",
    botId = "default",
    workspaceDir = process.cwd(),
  ): Promise<ResolvedSession> {
    return this.mutate(async () => {
      const threadId = topicIdOf(message);
      const key = sessionKey(botId, message.chatId, threadId);
      const existing = this.sessions.get(key);
      if (existing) return { session: existing, isNew: false };
      const now = this.now().toISOString();
      const session: Session = {
        id: this.createId(), botId, threadId, chatId: message.chatId, cliId,
        workspaceDir, status: "creating", createdAt: now, updatedAt: now,
      };
      await this.commit(session);
      return { session, isNew: true };
    });
  }

  async transition(sessionId: string, nextStatus: SessionStatus): Promise<Session> {
    return this.mutate(async () => {
      const current = this.requireSession(sessionId);
      if (!ALLOWED_TRANSITIONS[current.status].includes(nextStatus)) {
        throw new Error(`会话 ${current.status} 不能切换到 ${nextStatus}`);
      }
      return this.commit({ ...current, status: nextStatus, updatedAt: this.now().toISOString() });
    }, sessionId);
  }

  async setCliSessionId(sessionId: string, cliSessionId: string): Promise<Session> {
    if (!cliSessionId) throw new Error("CLI 会话 ID 不能为空");
    return this.updateCliSelection(sessionId, cliSessionId);
  }

  /** /new：解除当前绑定，下一条任务自然建立新的 CLI 会话。 */
  async clearCliSessionId(sessionId: string): Promise<Session> {
    return this.updateCliSelection(sessionId, undefined);
  }

  /** 定时任务开出话题时打上标记，删除时据此找回本话题所有在飞轮次。 */
  async setScheduleId(sessionId: string, scheduleId: string): Promise<Session> {
    if (!scheduleId) throw new Error("定时任务 ID 不能为空");
    return this.mutate(async () => {
      const current = this.requireSession(sessionId);
      if (current.scheduleId === scheduleId) return current;
      return this.commit({ ...current, scheduleId, updatedAt: this.now().toISOString() });
    }, sessionId);
  }

  async setWorkspaceDir(sessionId: string, workspaceDir: string): Promise<Session> {
    if (!workspaceDir) throw new Error("工作目录不能为空");
    return this.mutate(async () => {
      const current = this.requireSession(sessionId);
      if (current.workspaceDir === workspaceDir) return current;
      // 旧原生会话记着旧项目；目录提交成功时一并解除绑定，不能把失败变更带进后续更新。
      const { cliSessionId: _dropped, ...rest } = current;
      return this.commit({ ...rest, workspaceDir, updatedAt: this.now().toISOString() });
    }, sessionId);
  }

  private updateCliSelection(sessionId: string, cliSessionId: string | undefined): Promise<Session> {
    return this.mutate(async () => {
      const current = this.requireSession(sessionId);
      const { cliSessionId: _dropped, ...rest } = current;
      return this.commit({ ...rest, ...(cliSessionId ? { cliSessionId } : {}), updatedAt: this.now().toISOString() });
    }, sessionId);
  }

  private requireSession(sessionId: string): Session {
    const session = this.get(sessionId);
    if (!session) throw new Error(`会话不存在: ${sessionId}`);
    return session;
  }

  /** 读取、校验和更新一起排队；只排 save 会让后继操作继承前一次失败的暂存值。 */
  private mutate<T>(operation: () => Promise<T>, sessionId?: string): Promise<T> {
    if (sessionId) this.pendingUpdates.set(sessionId, (this.pendingUpdates.get(sessionId) ?? 0) + 1);
    const run = async () => {
      try { return await operation(); }
      finally {
        if (sessionId) {
          const remaining = (this.pendingUpdates.get(sessionId) ?? 1) - 1;
          if (remaining) this.pendingUpdates.set(sessionId, remaining);
          else this.pendingUpdates.delete(sessionId);
        }
      }
    };
    const result = this.mutationQueue.then(run, run);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  /** 只发布已落盘的快照；写失败时读者继续看旧版本，且写队列不会被污染。 */
  private async commit(updated: Session): Promise<Session> {
    const key = sessionKey(updated.botId, updated.chatId, updated.threadId);
    const staged = new Map(this.sessions);
    staged.set(key, updated);
    try {
      await this.store?.save([...staged.values()]);
    } catch (error) {
      // 防御存储在提交后抛错的实现；后继修改仍未出队，恢复的只能是完整旧快照。
      if (this.store) await this.store.save([...this.sessions.values()]).catch(rollbackError => {
        console.error("[会话] 回滚后重写失败，磁盘可能与内存不一致:", (rollbackError as Error).message);
      });
      throw error;
    }
    this.sessions.set(key, updated);
    return updated;
  }
}
