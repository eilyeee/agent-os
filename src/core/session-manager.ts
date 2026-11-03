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

  constructor(options: SessionManagerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.store = options.store;
  }

  static async open(
    options: SessionManagerOptions = {},
  ): Promise<SessionManager> {
    const manager = new SessionManager(options);
    const restored = (await options.store?.load()) ?? [];
    for (const session of restored) {
      manager.sessions.set(
        sessionKey(session.botId, session.chatId, session.threadId),
        session,
      );
    }
    return manager;
  }

  get size(): number {
    return this.sessions.size;
  }

  get(sessionId: string): Session | undefined {
    return [...this.sessions.values()].find((session) => session.id === sessionId);
  }

  async resolve(
    message: MessageAddress,
    cliId: CliId = "claude",
    botId = "default",
    workspaceDir = process.cwd(),
  ): Promise<ResolvedSession> {
    const threadId = topicIdOf(message);
    const key = sessionKey(botId, message.chatId, threadId);
    const existing = this.sessions.get(key);
    if (existing) return { session: existing, isNew: false };

    const now = this.now().toISOString();
    const session: Session = {
      id: this.createId(),
      botId,
      threadId,
      chatId: message.chatId,
      cliId,
      workspaceDir,
      status: "creating",
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(key, session);
    try {
      await this.persist();
    } catch (error) {
      // 首次落盘失败就撤回内存会话，下一条消息可以重新创建，不会卡在 creating。
      if (this.sessions.get(key) === session) this.sessions.delete(key);
      // 和 replace() 一样：撤回内存之后要再写一次，把磁盘拉回同一个版本。
      await this.persist().catch((rollbackError) => {
        console.error(
          "[会话] 回滚后重写失败，磁盘可能与内存不一致:",
          (rollbackError as Error).message,
        );
      });
      throw error;
    }
    return { session, isNew: true };
  }

  async transition(
    sessionId: string,
    nextStatus: SessionStatus,
  ): Promise<Session> {
    const current = this.get(sessionId);
    if (!current) throw new Error(`会话不存在: ${sessionId}`);
    if (!ALLOWED_TRANSITIONS[current.status].includes(nextStatus)) {
      throw new Error(`会话 ${current.status} 不能切换到 ${nextStatus}`);
    }
    return this.replace(current, {
      ...current,
      status: nextStatus,
      updatedAt: this.now().toISOString(),
    });
  }

  async setCliSessionId(
    sessionId: string,
    cliSessionId: string,
  ): Promise<Session> {
    if (!cliSessionId) throw new Error("CLI 会话 ID 不能为空");
    return this.updateCliSelection(sessionId, cliSessionId);
  }

  /** /new：解除当前绑定，下一条任务自然建立新的 CLI 会话。 */
  async clearCliSessionId(sessionId: string): Promise<Session> {
    return this.updateCliSelection(sessionId, undefined);
  }

  /** 定时任务开出话题时打上标记，删除那条任务时据此找回本话题所有在飞的轮次。 */
  async setScheduleId(sessionId: string, scheduleId: string): Promise<Session> {
    if (!scheduleId) throw new Error("定时任务 ID 不能为空");
    const current = this.get(sessionId);
    if (!current) throw new Error(`会话不存在: ${sessionId}`);
    if (current.scheduleId === scheduleId) return current;
    return this.replace(current, {
      ...current,
      scheduleId,
      updatedAt: this.now().toISOString(),
    });
  }

  async setWorkspaceDir(
    sessionId: string,
    workspaceDir: string,
  ): Promise<Session> {
    const current = this.get(sessionId);
    if (!current) throw new Error(`会话不存在: ${sessionId}`);
    if (!workspaceDir) throw new Error("工作目录不能为空");
    if (current.workspaceDir === workspaceDir) return current;

    // 旧 CLI 会话记着上一个项目的文件，留着会让模型引用错项目，
    // 所以切目录时解除绑定，保留飞书话题，下一条任务重建 CLI 会话。
    const { cliSessionId: _dropped, ...rest } = current;
    return this.replace(current, {
      ...rest,
      workspaceDir,
      updatedAt: this.now().toISOString(),
    });
  }

  private async updateCliSelection(
    sessionId: string,
    cliSessionId: string | undefined,
  ): Promise<Session> {
    const current = this.get(sessionId);
    if (!current) throw new Error(`会话不存在: ${sessionId}`);
    const { cliSessionId: _dropped, ...rest } = current;
    return this.replace(current, {
      ...rest,
      ...(cliSessionId ? { cliSessionId } : {}),
      updatedAt: this.now().toISOString(),
    });
  }

  /** 唯一的写入口：落盘成功时内存与磁盘一起前进，失败则回滚内存。 */
  private async replace(current: Session, updated: Session): Promise<Session> {
    const key = sessionKey(updated.botId, updated.chatId, updated.threadId);
    this.sessions.set(key, updated);
    try {
      await this.persist();
    } catch (error) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, current);
      // 回滚内存还不够：这次失败的快照可能已经落到磁盘上了（写队列里排在后面的
      // 那次成功写入会带着它）。再写一次，让磁盘和内存收敛回同一个版本。
      await this.persist().catch((rollbackError) => {
        console.error(
          "[会话] 回滚后重写失败，磁盘可能与内存不一致:",
          (rollbackError as Error).message,
        );
      });
      throw error;
    }
    return updated;
  }

  private async persist(): Promise<void> {
    await this.store?.save([...this.sessions.values()]);
  }
}
