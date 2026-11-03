/** 会话状态的展示与收尾。 */
import type { CliAdapter } from "../cli/types.js";
import type { Session, SessionManager } from "../core/session-manager.js";

const STATUS_LABELS: Record<Session["status"], string> = {
  creating: "创建中",
  active: "执行中",
  idle: "空闲",
  closed: "已关闭",
};

export function formatSessionStatus(
  session: Session,
  botId: string,
  adapter: CliAdapter,
): string {
  return [
    `机器人：${botId}`,
    `会话：${session.id}`,
    `状态：${STATUS_LABELS[session.status]}`,
    `执行引擎：${adapter.displayName}`,
    `CLI 会话：${session.cliSessionId ?? "(尚未建立)"}`,
    `工作目录：${session.workspaceDir}`,
    `话题：${session.threadId}`,
    `更新时间：${session.updatedAt}`,
  ].join("\n");
}

/**
 * 任务结束后必须回到 idle。
 * 少了这一步，一次网络波动就会让话题永远停在「执行中」，后续消息全被拒绝。
 */
export async function markSessionIdle(
  sessions: SessionManager,
  sessionId: string,
): Promise<void> {
  // 新话题可能在目录检查时就失败，creating 也必须释放；closed 不能被后台任务覆盖。
  const status = sessions.get(sessionId)?.status;
  if (status !== "active" && status !== "creating") return;
  await sessions.transition(sessionId, "idle");
  console.log(`[会话] id=${sessionId} status=idle`);
}
