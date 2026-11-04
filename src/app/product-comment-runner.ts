/**
 * 云文档评论评审：用户在待确认方案里 @产品经理，
 * 沿用原产品会话精确修改文档，再把结果写回同一条评论。
 */
import { isProductSpecOwner, type ProductSpecFlow } from "../core/product-spec.js";
import type { BotConfig } from "../core/bot-registry.js";
import { isUserAllowed, isChatAllowed } from "../core/access-control.js";
import { ensureAllowedWorkspace } from "../core/workspace.js";
import { findApprovalRequest } from "../core/approval.js";
import { findClarificationRequest } from "../core/clarification.js";
import type { CliRunResult } from "../cli/types.js";
import { cliFailureResult } from "../cli/runner.js";
import type { TaskRunStatus } from "../core/task-record.js";
import { TaskProgressTracker } from "../core/task-progress.js";
import { FEISHU_COMMENT_LIMIT } from "../im/lark.js";
import type { Bot, IncomingDocumentComment } from "../im/lark.js";
import { executeCli } from "./cli-execution.js";
import { markSessionIdle } from "./session-view.js";
import { recordCliTurn } from "./task-history.js";
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
  if (session.status !== "idle" || runtime.activeRuns.has(session.id) || runtime.sessions.isUpdating(session.id)) {
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
    ...(session.scheduleId ? { scheduleId: session.scheduleId } : {}),
  });

  let startedAt: Date | undefined;
  let result: CliRunResult | undefined;
  let outcome: TaskRunStatus | undefined;
  let answer: string | undefined;
  let failureReason: string | undefined;
  const progress = new TaskProgressTracker();

  try {
    await ensureAllowedWorkspace(session.workspaceDir, config);
    pendingCommentFlow(runtime, flow.token, comment);
    await runtime.sessions.transition(session.id, "active");
    // 落盘期间外部状态仍可能改变；确认与执行的边界不能停在 transition 之前。
    pendingCommentFlow(runtime, flow.token, comment);
    const adapter = runtime.getAdapter(session.cliId);
    startedAt = new Date();
    result = await executeCli(
      adapter,
      documentCommentPrompt(flow, comment),
      session.workspaceDir,
      session.cliSessionId,
      controller.signal,
      event => { progress.accept(event); },
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
    controller.signal.throwIfAborted();
    // 评论没有卡片回调入口；澄清留在原评论继续，其余应用请求明确退回原话题。
    const reply = commentResultReply(result);
    answer = reply;
    outcome = result.toolCalls?.length ? "waiting" : "success";
    const active = runtime.activeRuns.get(session.id);
    if (active?.controller === controller) active.committing = true;
    // 飞书单条评论只有 1000 字符，逐段发送才能保留每个问题及完整选项。
    for (let start = 0; start < reply.length;) {
      let end = Math.min(start + FEISHU_COMMENT_LIMIT, reply.length);
      if (end < reply.length && /[\uD800-\uDBFF]/.test(reply[end - 1]!)) end--;
      await bot.replyToDocumentComment(comment, reply.slice(start, end));
      start = end;
    }
  } catch (error) {
    result ??= cliFailureResult(error);
    outcome ??= controller.signal.aborted ? "cancelled" : "failed";
    if (outcome === "failed") failureReason = (error as Error).message;
    throw error;
  } finally {
    try {
      // 评论属于原方案的续跑；先记入同一 taskId，再释放占位，预算不能漏掉这轮消耗。
      if (startedAt && outcome) await recordCliTurn({
        runtime, session, taskId: flow.taskId, status: outcome, origin: "resume",
        ownerOpenId: flow.ownerOpenId,
        title: `文档评论 · ${flow.request.title}`,
        prompt: `评审产品方案《${flow.request.title}》的文档评论：${comment.commentId}${comment.replyId ? `，回复：${comment.replyId}` : ""}`,
        startedAt, progress: progress.snapshot(),
        ...(result ? { result } : {}),
        ...(answer !== undefined ? { answer } : {}),
        ...(failureReason ? { failureReason } : {}),
      });
    } finally {
      try {
        await markSessionIdle(runtime.sessions, session.id);
      } finally {
        // 与普通任务一致：空闲状态提交后才释放这一轮的占位。
        if (runtime.activeRuns.get(session.id)?.controller === controller) runtime.activeRuns.delete(session.id);
      }
    }
  }
}

/** 工具回执只是待处理请求，不能把空终态补成「文档已经改好」。 */
function commentResultReply(result: CliRunResult): string {
  const approval = findApprovalRequest(result.toolCalls);
  if (approval) return [
    `本轮停在审批请求：${approval.title}`,
    approval.summary,
    `影响范围：${approval.impact}`,
    approval.command ? `拟执行命令：${approval.command}` : "",
    "审批尚未发起，不能在评论里批准。请回到原飞书话题 @我，让我为这项操作发起审批卡；原方案确认卡继续有效。",
  ].filter(Boolean).join("\n\n");
  const clarification = findClarificationRequest(result.toolCalls);
  if (clarification && result.toolCalls?.every(call => call.toolName === "request_clarification")) return [
    `需要补充确认：${clarification.title}`,
    clarification.intro,
    ...clarification.questions.map((question, index) => [
      `${index + 1}. ${question.prompt}`,
      ...question.options.map(option => `${option.id}：${option.label}${option.id === question.recommendedOptionId ? "（推荐）" : ""}`),
    ].join("\n")),
    "请在本条评论中 @我，按题号回复你的选择或补充说明，我会沿用原会话继续修改文档。原方案确认卡继续有效。",
  ].filter(Boolean).join("\n\n");
  const requestLabels = { request_clarification: "需求澄清", request_approval: "操作审批", request_spec_approval: "方案确认", dispatch_task: "团队派发", schedule_manage: "定时任务" };
  if (result.toolCalls?.length) return [
    "本轮返回了需要在原飞书话题处理的应用请求，尚未执行，不能据此确认文档已更新。",
    `请求：${[...new Set(result.toolCalls.map(call => Object.hasOwn(requestLabels, call.toolName) ? requestLabels[call.toolName as keyof typeof requestLabels] : "应用操作"))].join("、")}`,
    "请回到原话题 @我，说明“继续处理文档评论中的应用请求”。原会话保留了请求内容，原方案确认卡继续有效。",
  ].join("\n\n");
  return result.answer || "本轮没有返回处理说明，无法确认文档是否修改。请复查原文档，或在本条评论中 @我 说明需要继续处理的内容。";
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
    "需要澄清时可以调用 request_clarification，问题会写回本条评论，用户会在这里 @你并回答。",
    "评论只用于原文档评审，不执行派活或定时任务，也不接受审批决定。需要其他应用操作时说明原因，提醒用户回原话题发起。",
  ]
    .filter(Boolean)
    .join("\n\n");
}
