/** CLI 轮次统一落历史：普通任务与文档评论共用成本和结局的记录口径。 */
import type { CliRunResult } from "../cli/types.js";
import type { Session } from "../core/session-manager.js";
import type { TaskRunOrigin, TaskRunStatus } from "../core/task-record.js";
import type { TaskProgressSnapshot } from "../core/task-progress.js";
import type { AppRuntime } from "./runtime.js";

export interface RecordCliTurnOptions {
  runtime: AppRuntime;
  session: Session;
  taskId: string;
  status: TaskRunStatus;
  origin: TaskRunOrigin;
  ownerOpenId: string;
  ownerName?: string;
  title: string;
  prompt: string;
  startedAt: Date;
  progress: Pick<TaskProgressSnapshot, "toolCount" | "completedCount">;
  result?: CliRunResult;
  answer?: string;
  failureReason?: string;
  editedFiles?: boolean;
  cardMessageId?: string;
}

/** 历史写失败不能改写执行结局，也不能阻断 finally 释放会话。 */
export async function recordCliTurn(options: RecordCliTurnOptions): Promise<void> {
  const { runtime, session, result, progress } = options;
  const cliSessionId = result?.sessionId ?? runtime.sessions.get(session.id)?.cliSessionId ?? session.cliSessionId;
  try {
    await runtime.taskRecords.append({
      taskId: options.taskId,
      botId: session.botId,
      chatId: session.chatId,
      threadId: session.threadId,
      sessionId: session.id,
      cliId: session.cliId,
      ...(cliSessionId ? { cliSessionId } : {}),
      workspaceDir: session.workspaceDir,
      origin: options.origin,
      ownerOpenId: options.ownerOpenId,
      ...(options.ownerName ? { ownerName: options.ownerName } : {}),
      title: options.title,
      prompt: options.prompt,
      status: options.status,
      answer: options.answer ?? result?.answer ?? "",
      ...(options.failureReason ? { failureReason: options.failureReason } : {}),
      startedAt: options.startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      toolCount: progress.toolCount,
      completedToolCount: progress.completedCount,
      ...(result?.stats?.turns !== undefined ? { turns: result.stats.turns } : {}),
      ...(result?.stats?.subagents?.length ? { subagents: result.stats.subagents } : {}),
      ...(result?.stats?.retries ? { retries: result.stats.retries } : {}),
      ...(options.editedFiles !== undefined ? { editedFiles: options.editedFiles } : {}),
      ...(result?.stats?.spinningOn ? { spinningOn: result.stats.spinningOn } : {}),
      ...(result?.stats?.totalTokens !== undefined ? { totalTokens: result.stats.totalTokens } : {}),
      ...(options.cardMessageId ? { cardMessageId: options.cardMessageId } : {}),
    });
    console.log(`[历史] 已记录 status=${options.status} origin=${options.origin} task=${options.taskId}`);
  } catch (error) {
    console.error("[历史] 任务记录写入失败:", (error as Error).message);
  }
}
