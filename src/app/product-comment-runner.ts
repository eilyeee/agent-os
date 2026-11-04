/**
 * 云文档评论评审：用户在待确认方案里 @产品经理，
 * 沿用原产品会话精确修改文档，再把结果写回同一条评论。
 */
import { isProductSpecOwner, type ProductSpecFlow } from "../core/product-spec.js";
import type { BotConfig } from "../core/bot-registry.js";
import { isUserAllowed, isChatAllowed } from "../core/access-control.js";
import { ensureAllowedWorkspace } from "../core/workspace.js";
import type { Bot, IncomingDocumentComment } from "../im/lark.js";
import { executeCli } from "./cli-execution.js";
import { markSessionIdle } from "./session-view.js";
import type { AppRuntime } from "./runtime.js";

export function canReviewProductComment(config: BotConfig, flow: ProductSpecFlow, comment: IncomingDocumentComment): boolean {
  return flow.status === "pending" && isUserAllowed(config, comment.senderOpenId) && isProductSpecOwner(flow, {
    operatorOpenId: comment.senderOpenId,
    operatorUnionId: comment.senderUnionId,
  });
}

function pendingCommentFlow(runtime: AppRuntime, flowToken: string, comment: IncomingDocumentComment): ProductSpecFlow {
  const flow = runtime.productSpecFlows.get(flowToken);
  if (!flow || flow.status !== "pending"
    || runtime.productSpecFlows.findPendingByDocument(flow.botId, comment.fileToken)?.token !== flow.token) {
    throw new Error("这份方案已确认或失效，评论未进入执行。请在话题中发起新的方案评审。");
  }
  return flow;
}

export async function runProductDocumentComment(options: {
  runtime: AppRuntime;
  bot: Bot;
  flow: ProductSpecFlow;
  comment: IncomingDocumentComment;
}): Promise<void> {
  const { runtime, bot, comment } = options;
  // 入队时的 pending 只是快照；等待表情接口或前一条评论期间，人可能已经确认方案。
  const flow = pendingCommentFlow(runtime, options.flow.token, comment);
  const config = runtime.botRuntimes.get(flow.botId)?.config;
  const session = runtime.sessions.get(flow.sessionId);
  if (!config || !canReviewProductComment(config, flow, comment) || !isChatAllowed(config, session?.chatId ?? "")) {
    throw new Error("只有已获授权的方案发起人可以通过评论修改文档。");
  }
  if (!session || session.status === "closed") {
    throw new Error("评论对应的产品会话已经失效");
  }
  if (session.status !== "idle" || runtime.activeRuns.has(session.id)) {
    throw new Error("评论对应的产品会话仍在执行其他任务");
  }
  if (!session.cliSessionId) {
    throw new Error("评论对应的产品 CLI 会话不存在");
  }
  const controller = new AbortController();
  // 与普通任务共用同步占位，目录检查和状态落盘期间也不能被另一个入口抢跑。
  runtime.activeRuns.set(session.id, {
    controller,
    ownerOpenId: flow.ownerOpenId,
  });

  try {
    await ensureAllowedWorkspace(session.workspaceDir, config);
    pendingCommentFlow(runtime, flow.token, comment);
    await runtime.sessions.transition(session.id, "active");
    const adapter = runtime.getAdapter(session.cliId);
    const result = await executeCli(
      adapter,
      documentCommentPrompt(flow, comment),
      session.workspaceDir,
      session.cliSessionId,
      controller.signal,
      undefined,
      (() => {
        const c = runtime.botRuntimes.get(flow.botId)?.config;
        return c
          ? {
              idleTimeoutMinutes: c.idleTimeoutMinutes,
              maxRuntimeMinutes: c.maxRuntimeMinutes,
            }
          : undefined;
      })(),
      undefined,
      async (nativeId) => {
        if (runtime.activeRuns.get(session.id)?.controller !== controller) throw new Error("评论任务已结束，无法更新原生会话绑定");
        await runtime.sessions.setCliSessionId(session.id, nativeId);
      },
    );
    if (result.sessionId) {
      await runtime.sessions.setCliSessionId(session.id, result.sessionId);
    }
    if (result.stats?.contextWindowTokens) {
      runtime.contextWindows.set(session.id, result.stats.contextWindowTokens);
    }
    await bot.replyToDocumentComment(
      comment,
      result.answer || "已按评论更新原文档，请复查。",
    );
  } finally {
    if (runtime.activeRuns.get(session.id)?.controller === controller) {
      runtime.activeRuns.delete(session.id);
    }
    await markSessionIdle(runtime.sessions, session.id);
  }
}

function documentCommentPrompt(
  flow: ProductSpecFlow,
  comment: IncomingDocumentComment,
): string {
  if (flow.request.deliveryMode !== "lark-doc") {
    throw new Error("本地产品方案不能处理飞书文档评论");
  }
  return [
    "用户在待确认的飞书产品方案中通过评论明确提及了你。",
    `文档 URL：${flow.request.documentUrl}`,
    `文档类型：${comment.fileType}`,
    `评论 ID：${comment.commentId}`,
    comment.replyId ? `触发回复 ID：${comment.replyId}` : "",
    "使用 lark-drive 读取这一条评论、完整回复和正文位置，再使用 lark-doc 精确修改原文档。",
    "修改成功后，最终回答只写一段给评论者看的简短说明，讲清楚具体改了什么。Agent OS 会把它写回原评论。",
    "不要调用评论回复或解决接口，评论是否解决由用户复查后决定。",
    "不要调用 request_spec_approval，不要生成新的确认卡；原待确认卡继续有效。",
  ]
    .filter(Boolean)
    .join("\n\n");
}
