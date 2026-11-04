/**
 * 任务主线：一次 CLI 执行的完整生命周期。
 * 飞书消息、卡片回答、审批结论和定时触发最终都走到这里，
 * 所以「两类入口共享同一套任务内核」不是口号，而是只有这一个实现。
 */
import { join } from "node:path";
import type { CardJson } from "../im/card.js";
import {
  answerContinuation,
  answerNeedsContinuation,
  buildApprovalCard,
  buildApprovalDecidedCard,
  buildClarificationCard,
  buildProductSpecApprovalCard,
  buildScheduleListCard,
  buildSessionNoticeCard,
  buildTaskCard,
  splitLongText,
  ThrottledCardUpdater,
} from "../im/card.js";
import {
  compactCliSession,
  type CompactCliSessionResult,
} from "../cli/native-compact.js";
import type { CliRunResult } from "../cli/types.js";
import { CLI_TIMEOUT_ERROR, cliFailureResult } from "../cli/runner.js";
import { PRODUCT_DOCUMENT_SKILLS } from "../core/bot-registry.js";
import { ensureAllowedWorkspace } from "../core/workspace.js";
import { findApprovalRequest, formatApprovalOutcome } from "../core/approval.js";
import { findClarificationRequest } from "../core/clarification.js";
import { findDispatchTaskRequest } from "../core/collaboration.js";
import type { CollaborationMessage } from "../core/collaboration.js";
import { findProductSpecRequest } from "../core/product-spec.js";
import { findScheduleManageRequest } from "../core/schedule.js";
import type { Session } from "../core/session-manager.js";
import { TaskProgressTracker } from "../core/task-progress.js";
import { abortScheduleRuns, type ActiveRun } from "../core/task-abort.js";
import { topicScopeIdOf } from "../core/topic-task.js";
import type { TaskRunOrigin, TaskRunStatus } from "../core/task-record.js";
import { executeCli } from "./cli-execution.js";
import {
  workspaceChanged,
  workspaceFingerprint,
} from "./workspace-changes.js";
import { COLLABORATION_BUDGET_REASON, sendCollaborationMessage } from "./collaboration-service.js";
import { sendResultNotification } from "./notification-service.js";
import { assertProductSpecDocuments } from "./product-spec-documents.js";
import { markSessionIdle } from "./session-view.js";
import { recordCliTurn } from "./task-history.js";
import type { AppRuntime, BotRuntime } from "./runtime.js";

export interface TaskContext {
  runtime: AppRuntime;
  botRuntime: BotRuntime;
  session: Session;
  taskId: string;
  /** 卡片和通知挂在哪条消息下面。 */
  replyToMessageId: string;
  replyInThread: boolean;
  /** 谁发起了这一轮。交接来的就是那台派活的 bot——写进历史，用来看清活是从哪来的。 */
  ownerOpenId: string;
  ownerUnionId?: string;
  /** 发起人显示名。飞书消息事件里没有人名，只有交接这类来源填得出。 */
  ownerName?: string;
  /**
   * 谁有资格拍板：回答澄清、批审批、确认产品方案、以及停止这一轮。
   * **必须是人**，不能和 ownerOpenId 混用——交接轮里 ownerOpenId 是那台派活的 bot，
   * 拿它当归属的话，卡片和「停止」按钮就锁在一台 bot 身上，人反而没资格动，
   * 任务永远停在那儿。真机上栽过：助理把活交回来后弹了澄清卡，用户点开是
   * 「只有任务发起人可以回答」。
   */
  decisionOwnerOpenId: string;
  decisionOwnerUnionId?: string;
  /** 这一轮由谁触发，写进任务记录，用来区分定时触发与团队交接。 */
  origin: TaskRunOrigin;
  /** 交给 CLI 的最终文本。 */
  prompt: string;
  /** 未经包装的任务原文，用于自动审查时说明原始诉求。 */
  taskText: string;
  cardTitle: string;
  collaboration?: CollaborationMessage;
  senderRuntime?: BotRuntime;
  /** 有值时走原生上下文整理，而不是普通任务。 */
  compact?: { instructions?: string };
  /**
   * 任务真正开跑（进度卡已发出、CLI 即将启动）时触发。
   * 调用方据此判断「这一轮确实接手了」——在此之前的任何失败都必须由调用方补偿。
   */
  onStarted?: () => void;
  /** 原生会话或执行事件已到达，卡片成功不能冒充执行引擎接收了续跑。 */
  onExecutionStarted?: () => void;
}

/** 任务准入检查：能不能在这个会话上开始一轮新的执行。 */
export function taskAdmission(
  runtime: AppRuntime,
  session: Session,
): { ok: true } | { ok: false; reason: string } {
  const current = runtime.sessions.get(session.id);
  if (!current) return { ok: false, reason: "对应的会话已经失效，请在原话题重试。" };
  if (current.status === "closed") {
    return { ok: false, reason: "这个话题的会话已经关闭，请新开一个话题继续。" };
  }
  if (current.status === "active") {
    return { ok: false, reason: "当前会话还在执行，请等任务结束后再追问。" };
  }
  if (runtime.activeRuns.has(session.id)) {
    return { ok: false, reason: "当前会话还在收尾，请稍后再试。" };
  }
  if (runtime.sessions.isUpdating(session.id)) {
    return { ok: false, reason: "当前会话正在保存更新，请稍后再试。" };
  }
  // 附件下载和通讯录查询会让出执行权，绑定可能已经成功切换，不能再使用入队时的快照。
  if (current.workspaceDir !== session.workspaceDir || current.cliSessionId !== session.cliSessionId || current.cliId !== session.cliId) {
    return { ok: false, reason: "会话绑定已经更新，这条消息未进入执行。请在原话题重试。" };
  }
  return { ok: true };
}

/**
 * 一轮执行的真实结局。调度器等调用方据此记录，不能一律当成功。
 * 直接复用任务记录里的状态取值：卡片、调度器与历史必须是同一套词汇。
 */
export type TurnOutcome = TaskRunStatus;

export async function runCliTurn(ctx: TaskContext): Promise<TurnOutcome> {
  const { runtime, botRuntime, session } = ctx;
  const { bot } = botRuntime;
  const isCompacting = !!ctx.compact;

  // 先同步占位再 await：否则两条紧邻的消息会同时通过准入检查，起两个 CLI 进程。
  // 必须是「占位」而不是「覆盖」——覆盖会把仍在运行的那一轮从清单里挤掉，
  // 它的 CLI 就再也停不下来（停止按钮和 /close 都查不到它）。
  const admission = taskAdmission(runtime, session);
  if (!admission.ok) throw new Error(admission.reason);
  const adapter = runtime.getAdapter(session.cliId);
  const controller = new AbortController();
  const activeRun: ActiveRun = {
    controller,
    // 中止是拍板动作：交接轮里也必须由人点得动
    ownerOpenId: ctx.decisionOwnerOpenId,
    // 从会话读，不从这一轮读：续跑、交接、审批后重启的轮次都能自动带上
    ...(session.scheduleId ? { scheduleId: session.scheduleId } : {}),
  };
  runtime.activeRuns.set(session.id, activeRun);

  try {
    // 恢复旧会话、交接与卡片续跑都经过这里，不能只在 /cd 处限制新目录。
    await ensureAllowedWorkspace(session.workspaceDir, botRuntime.config);
    await runtime.sessions.transition(session.id, "active");
  } catch (error) {
    // 目录拒绝同样必须收尾：旧会话不能因新增的边界检查卡在 creating。
    await releaseSession(runtime, session.id, controller);
    throw error;
  }

  let cardId: string | undefined;
  try {
    cardId = await bot.replyCard(
      ctx.replyToMessageId,
      buildTaskCard({
        title: ctx.cardTitle,
        status: "running",
        detail: isCompacting
          ? `正在调用 ${adapter.displayName} 原生上下文整理`
          : "正在理解任务",
        abortSessionId: session.id,
      }),
      ctx.replyInThread,
    );
  } catch (error) {
    // 卡片发不出去就不要真的开工，否则用户毫无反馈、后台却已经在跑。
    await releaseSession(runtime, session.id, controller);
    throw error;
  }

  if (!cardId) {
    console.error("[卡片] 响应里没有 message_id，无法继续更新");
    await releaseSession(runtime, session.id, controller);
    return "failed";
  }
  const progressCardId = cardId;
  // 到这里进度卡已经在话题里了，任务确实接手了。
  ctx.onStarted?.();

  // 记录的起点也在这里：卡片之前的两条退出路径 CLI 从没启动过，
  // 记下来只会在历史里凭空多出一条用户从没见过的任务。
  const startedAt = new Date();
  // 结局一确定就先存下来，再去刷卡片、发通知。
  // 展示层抛错时，历史里留下的仍然是这一轮真实的结果。
  let outcome: TurnOutcome | undefined;
  let failureReason: string | undefined;
  let runResult: CliRunResult | undefined;
  /**
   * 这一轮改没改过工作区。**看结果，不看它用了什么工具**——
   * 真机上引擎是用 Bash 跑 python 改的文件（一轮 6 次），
   * 子 Agent 改的更是压根不出现在主轮次的事件流里。
   * undefined 表示「不知道」（不是 git 仓库、或 git 取不到），不是「没改过」。
   */
  let editedFiles: boolean | undefined;
  const fingerprintBefore = await workspaceFingerprint(session.workspaceDir);

  // 上游临时故障重试时，卡片要说清任务还在，不是死了。
  let retryNote: string | undefined;
  const progress = new TaskProgressTracker(
    Date.now,
    runtime.contextWindows.get(session.id),
    !session.cliSessionId,
  );
  const cardUpdater = new ThrottledCardUpdater((card) =>
    bot.updateCard(progressCardId, card),
  );
  const renderProgress = () => {
    const snapshot = progress.snapshot();
    cardUpdater.push(
      buildTaskCard({
        title: ctx.cardTitle,
        status: "running",
        detail: retryNote
          ? `${retryNote}\n${snapshot.current}`
          : isCompacting
            ? `正在调用 ${adapter.displayName} 原生上下文整理`
            : snapshot.current,
        ...(isCompacting ? {} : { progress: snapshot }),
        abortSessionId: session.id,
      }),
    );
  };
  // 模型长时间思考、没有新事件时，心跳保证卡片上的耗时仍在走。
  const heartbeat = setInterval(renderProgress, 1_000);
  heartbeat.unref();

  // 压缩结果单独留一份：是否真的压缩过由 compacted 决定，不能用 message 是否为空来猜。
  let compactResult: CompactCliSessionResult | undefined;
  let executionObserved = false;
  const execution: Promise<CliRunResult> = isCompacting
    ? compactCliSession({
        adapter,
        sessionId: session.cliSessionId!,
        cwd: session.workspaceDir,
        ...(ctx.compact?.instructions
          ? { instructions: ctx.compact.instructions }
          : {}),
        signal: controller.signal,
      }).then((result) => {
        compactResult = result;
        return { answer: result.message ?? "", sessionId: result.sessionId };
      })
    : executeCli(
        adapter,
        ctx.prompt,
        session.workspaceDir,
        session.cliSessionId,
        controller.signal,
        (event) => {
          if (!executionObserved && (
            ["session", "tool_start", "tool_end", "tool_call", "context", "subagent"].includes(event.type)
            || (event.type === "result" && (event.answer || event.final || (event.stats?.totalTokens ?? 0) > 0))
            || (event.type === "usage" && Object.values(event.stats).some(value => typeof value === "number" && value > 0))
          )) {
            executionObserved = true;
            ctx.onExecutionStarted?.();
          }
          if (
            event.type !== "tool_start" &&
            event.type !== "tool_end" &&
            event.type !== "context"
          ) {
            return;
          }
          progress.accept(event);
          renderProgress();
        },
        {
          idleTimeoutMinutes: botRuntime.config.idleTimeoutMinutes,
          maxRuntimeMinutes: botRuntime.config.maxRuntimeMinutes,
        },
        (attempt, error) => {
          retryNote = `⚠️ 上游临时故障，正在重试（第 ${attempt} 次）：${error.message.slice(0, 80)}`;
          renderProgress();
        },
        async (nativeId) => {
          if (runtime.activeRuns.get(session.id)?.controller !== controller) throw new Error("任务已结束，无法更新原生会话绑定");
          await runtime.sessions.setCliSessionId(session.id, nativeId);
        },
      );

  try {
    const result = await execution;
    runResult = result;
    clearInterval(heartbeat);

    if (!isCompacting && result.sessionId && runtime.sessions.get(session.id)?.cliSessionId !== result.sessionId) {
      await runtime.sessions.setCliSessionId(session.id, result.sessionId);
    }
    if (!isCompacting && result.stats?.contextWindowTokens) {
      runtime.contextWindows.set(session.id, result.stats.contextWindowTokens);
    }
    controller.signal.throwIfAborted();

    if (isCompacting) {
      beginTaskCommit(activeRun);
      outcome = "success";
      const compacted = compactResult?.compacted ?? false;
      await cardUpdater.finish(
        buildSessionNoticeCard({
          title: compacted ? "上下文已整理" : "暂时无需整理",
          template: compacted ? "green" : "grey",
          detail: [
            compactResult?.message,
            compacted
              ? [
                  `${adapter.displayName} 已在当前 CLI 会话内完成原生压缩。`,
                  "CLI 会话 ID 保持不变，下一条任务会继续使用整理后的上下文。",
                ].join("\n\n")
              : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        }),
      );
      return "success";
    }

    const handled = await handleAppToolOutcome(
      ctx,
      result,
      cardUpdater,
      progressCardId,
      activeRun,
    );
    if (handled) {
      outcome = handled.outcome;
      failureReason = handled.failureReason;
      return handled.outcome;
    }
    console.log(
      `[CLI] ${adapter.id} 完成 session_id=${result.sessionId ?? "(无)"}`,
    );
    const continued = await continueCollaboration(ctx, result.answer, activeRun, result.stats?.totalTokens);
    beginTaskCommit(activeRun);
    outcome = continued.outcome;
    failureReason = continued.failureReason;

    // 终态只能提交一次：先确定后续协作结局，不能先关成绿卡再试图补一张失败卡。
    // 展示失败仍只记日志，不改变已经确定的任务结局。
    await cardUpdater.finish(
      buildTaskCard({
        title: ctx.cardTitle,
        status: outcome === "failed" ? "failed" : "success",
        detail: outcome === "failed" ? "本轮执行已结束，后续协作未启动。" : outcome === "forwarded" ? "已交给团队成员继续" : "执行完成",
        ...(failureReason ? { technicalDetail: failureReason } : {}),
        progress: progress.snapshot(),
        answer: result.answer,
        ...(result.stats ? { stats: result.stats } : {}),
      }),
    );
    // 长答案续发同样是展示层，不能改写已经确定的结局。
    if (answerNeedsContinuation(result.answer)) {
      try {
        for (const chunk of splitLongText(answerContinuation(result.answer))) {
          await bot.reply(ctx.replyToMessageId, chunk, ctx.replyInThread);
        }
      } catch (error) {
        console.error("[卡片] 长答案续发失败:", (error as Error).message);
      }
    }
    return outcome;
  } catch (error) {
    clearInterval(heartbeat);
    runResult ??= cliFailureResult(error);
    if (controller.signal.aborted) {
      outcome = "cancelled";
      console.log("[CLI] 任务已取消");
      await cardUpdater.finish(
        buildTaskCard({
          title: ctx.cardTitle,
          status: "cancelled",
          detail:
            activeRun.cancelMode === "close"
              ? "本次任务已停止，当前会话已经关闭。"
              : isCompacting
                ? "整理已停止，当前 CLI 会话没有改变。"
                : "本次任务已停止。你可以继续在当前话题里提问。",
          progress: progress.snapshot(),
        }),
      );
      return "cancelled";
    }
    const message = (error as Error).message;
    beginTaskCommit(activeRun);
    outcome = "failed";
    failureReason = message;
    console.error("[CLI] 执行失败:", message);
    await cardUpdater.finish(
      buildTaskCard({
        title: ctx.cardTitle,
        status: "failed",
        detail: isCompacting
          ? "上下文整理失败，当前 CLI 会话没有改变。"
          : error instanceof Error && error.name === CLI_TIMEOUT_ERROR
            ? "执行超时被中止。工作区里可能已经有改到一半的内容，先用 git 看一眼再决定重试还是回退。"
            : "执行没有完成。你可以调整指令后，在当前话题里重试。",
        technicalDetail: message,
        progress: progress.snapshot(),
      }),
    );
    await sendResultNotification({
      bot,
      replyToMessageId: ctx.replyToMessageId,
      target: ctx.senderRuntime?.identity ?? { openId: ctx.ownerOpenId, name: "" },
      text: "任务执行失败，请查看上方错误信息。",
      replyInThread: ctx.replyInThread,
    });
    return "failed";
  } finally {
    editedFiles = workspaceChanged(
      fingerprintBefore,
      await workspaceFingerprint(session.workspaceDir),
    );
    clearInterval(heartbeat);
    // 落一条历史，和清理 activeRuns 一样属于「每条退出路径都要做」的收尾。
    // /compact 是上下文维护不是任务，不进历史。
    if (!isCompacting && outcome) {
      await recordCliTurn({
        runtime,
        session,
        taskId: ctx.taskId,
        origin: ctx.origin,
        ownerOpenId: ctx.ownerOpenId,
        ...(ctx.ownerName ? { ownerName: ctx.ownerName } : {}),
        title: ctx.cardTitle,
        prompt: ctx.taskText,
        status: outcome,
        startedAt,
        progress: progress.snapshot(),
        cardMessageId: progressCardId,
        ...(runResult ? { result: runResult } : {}),
        ...(failureReason ? { failureReason } : {}),
        ...(editedFiles !== undefined ? { editedFiles } : {}),
      });
    }
    await releaseSession(runtime, session.id, controller);
  }
}

/** 无论走哪条分支，最后都要清掉运行记录并把会话还原成空闲。 */
async function releaseSession(
  runtime: AppRuntime,
  sessionId: string,
  controller: AbortController,
): Promise<void> {
  try {
    await markSessionIdle(runtime.sessions, sessionId);
  } catch (error) {
    console.error("[会话] 保存空闲状态失败:", (error as Error).message);
  } finally {
    // 状态提交之前仍在收尾，不能先摘占位再让下一条消息读到旧 active。
    if (runtime.activeRuns.get(sessionId)?.controller === controller) runtime.activeRuns.delete(sessionId);
  }
}

/**
 * 应用工具的结果处理，按安全优先级排序：
 * 审批 > 需求澄清 > 产品方案 > 定时任务 > 团队派发。
 * 命中任何一项都会结束本轮，不再进入普通完成流程和自动审查。
 * 失败分支同时带回原因：红卡上写了什么，历史记录里就该留下什么。
 *
 * 结局分两类，不能混：前三项弹出卡片等人拍板，任务停在半路 → waiting；
 * 后两项这一轮确实做完了，只是结果流转了出去 → forwarded，历史里计入「成功」。
 */
async function handleAppToolOutcome(
  ctx: TaskContext,
  result: CliRunResult,
  cardUpdater: ThrottledCardUpdater,
  cardMessageId: string,
  activeRun: ActiveRun,
): Promise<{ outcome: TurnOutcome; failureReason?: string } | undefined> {
  const { runtime, botRuntime, session } = ctx;
  const { bot, config } = botRuntime;
  activeRun.controller.signal.throwIfAborted();

  const approvalRequest = findApprovalRequest(result.toolCalls);
  if (approvalRequest) {
    beginTaskCommit(activeRun);
    const flow = runtime.approvalFlows.create({
      taskId: ctx.taskId,
      botId: config.id,
      sessionId: session.id,
      ownerOpenId: ctx.decisionOwnerOpenId,
      ...(ctx.decisionOwnerUnionId
        ? { ownerUnionId: ctx.decisionOwnerUnionId }
        : {}),
      originalMessageId: ctx.replyToMessageId,
      cardMessageId,
      replyInThread: ctx.replyInThread,
      request: approvalRequest,
    });
    await cardUpdater.finish(buildApprovalCard(flow));
    await sendResultNotification({
      bot,
      replyToMessageId: ctx.replyToMessageId,
      target: { openId: ctx.decisionOwnerOpenId, name: "" },
      text: `有一个高危操作等待你拍板：${approvalRequest.title}`,
      replyInThread: ctx.replyInThread,
    });
    console.log(
      `[审批] 已发出审批卡 risk=${approvalRequest.risk} title=${approvalRequest.title} token=${flow.token.slice(0, 8)}`,
    );
    scheduleApprovalTimeout(ctx, flow.token);
    return { outcome: "waiting" };
  }

  const clarificationRequest = findClarificationRequest(result.toolCalls);
  if (clarificationRequest) {
    beginTaskCommit(activeRun);
    const flow = runtime.clarificationFlows.create({
      taskId: ctx.taskId,
      topicId: topicScopeIdOf(session.chatId, session.threadId),
      botId: config.id,
      sessionId: session.id,
      ownerOpenId: ctx.decisionOwnerOpenId,
      ...(ctx.decisionOwnerUnionId
        ? { ownerUnionId: ctx.decisionOwnerUnionId }
        : {}),
      originalMessageId: ctx.replyToMessageId,
      cardMessageId,
      replyInThread: ctx.replyInThread,
      request: clarificationRequest,
    });
    await cardUpdater.finish(buildClarificationCard({ flow }));
    await sendResultNotification({
      bot,
      replyToMessageId: ctx.replyToMessageId,
      target: { openId: ctx.decisionOwnerOpenId, name: "" },
      text: `需要确认 ${clarificationRequest.questions.length} 个问题，请在上方卡片中选择。`,
      replyInThread: ctx.replyInThread,
    });
    console.log(
      `[澄清] 已发出问题卡 ${clarificationRequest.questions.length} 题 token=${flow.token.slice(0, 8)}`,
    );
    return { outcome: "waiting" };
  }

  const managesProductDocuments = config.skills.some((skill) =>
    PRODUCT_DOCUMENT_SKILLS.includes(skill),
  );
  const productSpecRequest = managesProductDocuments
    ? findProductSpecRequest(result.toolCalls)
    : undefined;
  if (productSpecRequest) {
    if (productSpecRequest.deliveryMode === "local") {
      await assertProductSpecDocuments(session.workspaceDir, productSpecRequest);
    }
    beginTaskCommit(activeRun);
    const flow = runtime.productSpecFlows.create({
      taskId: ctx.taskId,
      topicId: topicScopeIdOf(session.chatId, session.threadId),
      botId: config.id,
      sessionId: session.id,
      ownerOpenId: ctx.decisionOwnerOpenId,
      ...(ctx.decisionOwnerUnionId
        ? { ownerUnionId: ctx.decisionOwnerUnionId }
        : {}),
      request: productSpecRequest,
    });
    await cardUpdater.finish(buildProductSpecApprovalCard(flow));
    await sendResultNotification({
      bot,
      replyToMessageId: ctx.replyToMessageId,
      target: { openId: ctx.decisionOwnerOpenId, name: "" },
      text: "产品方案已生成，请查看上方确认卡。",
      replyInThread: ctx.replyInThread,
    });
    console.log(
      `[产品] 已发出待确认卡 mode=${productSpecRequest.deliveryMode} token=${flow.token.slice(0, 8)}`,
    );
    return { outcome: "waiting" };
  }

  const scheduleRequest = findScheduleManageRequest(result.toolCalls);
  if (scheduleRequest) {
    beginTaskCommit(activeRun);
    const applied = await applyScheduleRequest(ctx, scheduleRequest);
    console.log(
      `[定时] 工具调用 action=${scheduleRequest.action} 结果=${applied.ok ? "成功" : "失败"}`,
    );
    await cardUpdater.finish(applied.card);
    // 定时任务没改成不是一次交接，调用方（尤其是调度器）必须知道这轮失败了。
    if (applied.ok) return { outcome: "forwarded" };
    return { outcome: "failed", failureReason: applied.error };
  }

  const dispatchRequest = findDispatchTaskRequest(result.toolCalls);
  if (dispatchRequest) {
    const target = runtime.teamRegistry.get(dispatchRequest.toBotId);
    if (!target || dispatchRequest.toBotId === config.id) {
      beginTaskCommit(activeRun);
      await cardUpdater.finish(
        buildSessionNoticeCard({
          title: "派发失败",
          template: "red",
          detail: `团队里没有可派发的成员：${dispatchRequest.toBotId}。发送 /team 可以查看名册。`,
        }),
      );
      // 红卡就是失败，不能当成一次成功的交接。
      return {
        outcome: "failed",
        failureReason: `团队里没有可派发的成员：${dispatchRequest.toBotId}`,
      };
    }
    // 先真正派出去再宣布成功：反过来的话，派发失败会留下一张
    // 「已交给团队成员继续」的绿卡，而任务其实已经掉了。
    // 这里不吞异常——runCliTurn 的 catch 会渲染带技术细节的红色失败卡。
    const sent = await sendCollaborationMessage({
      runtime,
      sender: botRuntime,
      signal: activeRun.controller.signal,
      onDeliveryStarted: () => beginTaskCommit(activeRun),
      ...(result.stats?.totalTokens
        ? { spentThisTurn: result.stats.totalTokens }
        : {}),
      replyToMessageId: ctx.replyToMessageId,
      targetBotId: dispatchRequest.toBotId,
      chatId: session.chatId,
      threadId: session.threadId,
      taskId: ctx.taskId,
      kind: "forward",
      round: (ctx.collaboration?.round ?? 0) + 1,
      maxRounds: ctx.collaboration?.maxRounds ?? config.collaborationMaxRounds,
      workspaceDir: dispatchRequest.workspaceDir ?? session.workspaceDir,
      prompt: dispatchRequest.task,
    });
    if (!sent) {
      beginTaskCommit(activeRun);
      await cardUpdater.finish(buildSessionNoticeCard({
        title: "任务未派发",
        template: "red",
        detail: COLLABORATION_BUDGET_REASON,
      }));
      return { outcome: "failed", failureReason: COLLABORATION_BUDGET_REASON };
    }
    await cardUpdater.finish(
      buildTaskCard({
        title: ctx.cardTitle,
        status: "success",
        detail: "已交给团队成员继续",
        answer: result.answer,
        ...(result.stats ? { stats: result.stats } : {}),
      }),
    );
    return { outcome: "forwarded" };
  }

  return undefined;
}

/** 定时任务归属校验：一台 bot 不能删改另一台 bot 的任务。 */
function assertOwnSchedule(ctx: TaskContext, id: string): void {
  const schedule = ctx.runtime.schedules.get(id);
  if (!schedule) throw new Error(`定时任务不存在: ${id}`);
  if (schedule.botId !== ctx.botRuntime.config.id) {
    throw new Error(`定时任务 ${id} 属于其他成员，无法修改。`);
  }
  // 群 id 同样是硬约束：只校验 bot 的话，在 A 群说一句「删掉 xxx」
  // 就能删掉这台 bot 在 B 群的定时任务，而 B 群那边毫无察觉。
  if (schedule.chatId !== ctx.session.chatId) {
    throw new Error(`定时任务 ${id} 属于其他群，无法修改。`);
  }
}

async function applyScheduleRequest(
  ctx: TaskContext,
  request: {
    action: "create" | "update" | "delete" | "enable" | "disable";
    id?: string;
    name?: string;
    cron?: string;
    prompt?: string;
    workspaceDir?: string;
  },
): Promise<{ ok: boolean; card: CardJson; error?: string }> {
  const { runtime, botRuntime, session } = ctx;
  try {
    if (request.action === "create") {
      // Schema 已保证 create 时这三项都在。
      await runtime.schedules.create({
        botId: botRuntime.config.id,
        chatId: session.chatId,
        name: request.name!,
        cron: request.cron!,
        prompt: request.prompt!,
        workspaceDir: request.workspaceDir ?? session.workspaceDir,
      });
    } else if (request.action === "delete") {
      assertOwnSchedule(ctx, request.id!);
      await runtime.schedules.remove(request.id!);
      // 和卡片上那个删除按钮走同一套：摘掉存储记录只是让它不再触发，
      // 已经跑起来的那一轮不会自己停。两个入口对同一件事必须给出同一种结果，
      // 只修一边的话，换个入口那个 bug 就原样还在。
      const running = abortScheduleRuns(runtime.activeRuns, request.id!);
      console.log(
        `[定时] 工具删除 id=${request.id} bot=${botRuntime.config.id} 本轮=${running}`,
      );
    } else {
      assertOwnSchedule(ctx, request.id!);
      const patch: Record<string, unknown> = {};
      if (request.name) patch.name = request.name;
      if (request.cron) patch.cron = request.cron;
      if (request.prompt) patch.prompt = request.prompt;
      if (request.workspaceDir) patch.workspaceDir = request.workspaceDir;
      if (request.action === "enable") patch.enabled = true;
      if (request.action === "disable") patch.enabled = false;
      await runtime.schedules.update(request.id!, patch);
    }
    return {
      ok: true,
      card: buildScheduleListCard(
        runtime.schedules.listForScope(botRuntime.config.id, session.chatId),
        { botId: botRuntime.config.id, chatId: session.chatId },
      ),
    };
  } catch (error) {
    const message = (error as Error).message;
    return {
      ok: false,
      error: message,
      card: buildSessionNoticeCard({
        title: "定时任务未更新",
        template: "red",
        detail: message,
      }),
    };
  }
}

/** 超时未拍板视为未批准，同样要把开发者会话恢复回来。 */
function scheduleApprovalTimeout(ctx: TaskContext, token: string): void {
  if (!ctx.ownerOpenId) {
    console.warn(
      "[审批] 本轮没有可点名的发起人，审批卡无人可批。请在 .env 配置 OWNER_OPEN_ID",
    );
  }
  const flow = ctx.runtime.approvalFlows.get(token);
  if (!flow) return;
  const arm = (delay: number) => {
    const timer = setTimeout(() => {
      const current = ctx.runtime.approvalFlows.get(token);
      if (!current || current.status !== "pending") return;
      // 会话正忙时不要把结论烧掉——和按钮那一侧同一条规则，顺延到它空下来再说。
      const session = ctx.runtime.sessions.get(current.sessionId);
      if (session && session.status === "active") {
        arm(30_000);
        return;
      }
      const expired = ctx.runtime.approvalFlows.decide(token, "expired");
      if (!expired) return;
      // 到期要把卡片换成终态，否则按钮还挂在那里，用户点了只会得到「已经失效」。
      if (expired.cardMessageId) {
        void ctx.botRuntime.bot
          .updateCard(expired.cardMessageId, buildApprovalDecidedCard(expired))
          .catch((error) =>
            console.error("[审批] 超时卡片更新失败:", (error as Error).message),
          );
      }
      void resumeAfterApproval(ctx.runtime, ctx.botRuntime, token).catch(
        (error) => {
          console.error("[审批] 超时恢复会话失败:", (error as Error).message);
        },
      );
    }, delay);
    timer.unref();
  };
  arm(Math.max(1_000, Date.parse(flow.expiresAt) - Date.now()));
}

export async function resumeAfterApproval(
  runtime: AppRuntime,
  botRuntime: BotRuntime,
  token: string,
): Promise<void> {
  const flow = runtime.approvalFlows.get(token);
  if (!flow || flow.status === "pending") return;
  console.log(`[审批] 结论=${flow.status}，正在恢复会话 ${flow.sessionId}`);
  try {
    // 先送达再销毁：中间失败时结论还在，可以退回去重来，不会凭空消失。
    await resumeSession({
      runtime,
      botRuntime,
      sessionId: flow.sessionId,
      taskId: flow.taskId,
      replyToMessageId: flow.originalMessageId,
      replyInThread: flow.replyInThread,
      ownerOpenId: flow.ownerOpenId,
      ...(flow.ownerUnionId ? { ownerUnionId: flow.ownerUnionId } : {}),
      text: formatApprovalOutcome(flow),
    });
  } catch (error) {
    // 结论没送到 CLI：把它退回待处理，卡片按钮重新可用，用户能再点一次。
    const reverted = runtime.approvalFlows.revertToPending(token);
    console.error("[审批] 结论未能送达，已退回待处理:", (error as Error).message);
    if (reverted?.cardMessageId) {
      await botRuntime.bot
        .updateCard(reverted.cardMessageId, buildApprovalCard(reverted))
        .catch(() => undefined);
    }
    await botRuntime.bot
      .reply(
        flow.originalMessageId,
        `审批结论暂时没能送达执行引擎（${(error as Error).message}），请稍后在上方卡片重新拍板。`,
        flow.replyInThread,
      )
      .catch(() => undefined);
    return;
  }
  runtime.approvalFlows.delete(token);
}

export interface ResumeSessionOptions {
  runtime: AppRuntime;
  botRuntime: BotRuntime;
  sessionId: string;
  taskId: string;
  replyToMessageId: string;
  replyInThread: boolean;
  ownerOpenId: string;
  ownerUnionId?: string;
  /** 续接文本直接交给已有 CLI 会话，角色上下文在首轮就已经建立。 */
  text: string;
}

export async function resumeSession(
  options: ResumeSessionOptions,
): Promise<void> {
  const session = options.runtime.sessions.get(options.sessionId);
  if (!session) throw new Error("对应的会话已经失效");
  const admission = taskAdmission(options.runtime, session);
  if (!admission.ok) throw new Error(admission.reason);

  let started = false;
  await runCliTurn({
    runtime: options.runtime,
    botRuntime: options.botRuntime,
    session,
    taskId: options.taskId,
    replyToMessageId: options.replyToMessageId,
    replyInThread: options.replyInThread,
    ownerOpenId: options.ownerOpenId,
    ...(options.ownerUnionId ? { ownerUnionId: options.ownerUnionId } : {}),
    // 续跑是人拍完板之后发起的，发起人和拍板人本就是同一个
    decisionOwnerOpenId: options.ownerOpenId,
    ...(options.ownerUnionId
      ? { decisionOwnerUnionId: options.ownerUnionId }
      : {}),
    // 澄清与审批拍板之后的续跑都走这里，历史里单独算一条。
    origin: "resume",
    prompt: options.text,
    taskText: options.text,
    cardTitle: options.runtime.getAdapter(session.cliId).displayName,
    onExecutionStarted: () => { started = true; },
  });
  // 卡片成功、甚至 shell 启动都不代表引擎接收了结论；未观察到原生执行时保留人类决定。
  if (!started) throw new Error("本轮没有进入执行，请在原话题重试；已确认的答案或审批结论仍保留。");
}

/** 一轮结束后的团队流转：返工、自动审查，或只发一条完成通知。 */
async function continueCollaboration(
  ctx: TaskContext,
  answer: string,
  activeRun: ActiveRun,
  /** 本轮花掉的 token：预算检查要算上它，本轮记录此刻还没落盘。 */
  spentThisTurn?: number,
): Promise<{ outcome: TurnOutcome; failureReason?: string }> {
  const { runtime, botRuntime, session } = ctx;
  const { config } = botRuntime;
  try {
    activeRun.controller.signal.throwIfAborted();
    if (ctx.collaboration && ctx.collaboration.round < ctx.collaboration.maxRounds) {
      const sent = await sendCollaborationMessage({
        runtime,
        sender: botRuntime,
        signal: activeRun.controller.signal,
        onDeliveryStarted: () => beginTaskCommit(activeRun),
        replyToMessageId: ctx.replyToMessageId,
        targetBotId: ctx.collaboration.fromBotId,
        chatId: session.chatId,
        threadId: session.threadId,
        taskId: ctx.collaboration.taskId,
        kind: "return",
        round: ctx.collaboration.round + 1,
        maxRounds: ctx.collaboration.maxRounds,
        workspaceDir: session.workspaceDir,
        prompt: answer || "任务已完成，请检查当前工作目录。",
        ...(spentThisTurn ? { spentThisTurn } : {}),
      });
      return sent ? { outcome: "forwarded" } : { outcome: "failed", failureReason: COLLABORATION_BUDGET_REASON };
    }
    if (!ctx.collaboration && config.reviewBy) {
      const sent = await sendCollaborationMessage({
        runtime,
        sender: botRuntime,
        signal: activeRun.controller.signal,
        onDeliveryStarted: () => beginTaskCommit(activeRun),
        replyToMessageId: ctx.replyToMessageId,
        targetBotId: config.reviewBy,
        chatId: session.chatId,
        threadId: session.threadId,
        taskId: ctx.taskId,
        kind: "forward",
        round: 1,
        maxRounds: config.collaborationMaxRounds,
        workspaceDir: session.workspaceDir,
        ...(spentThisTurn ? { spentThisTurn } : {}),
        prompt: [
          "请独立检查当前工作目录中刚完成的实现。",
          `原始任务：${ctx.taskText}`,
          "请直接读取代码和改动，指出明确问题；没有问题时说明检查通过。",
        ].join("\n\n"),
      });
      return sent ? { outcome: "forwarded" } : { outcome: "failed", failureReason: COLLABORATION_BUDGET_REASON };
    }
    beginTaskCommit(activeRun);
    if (ctx.collaboration && ctx.senderRuntime) {
      await sendResultNotification({
        bot: botRuntime.bot,
        replyToMessageId: ctx.replyToMessageId,
        target: ctx.senderRuntime.identity,
        text: "本轮协作已完成，请查看上方结果。",
        replyInThread: ctx.replyInThread,
      });
    }
    return { outcome: "success" };
  } catch (error) {
    // 通知尚未提交时的取消属于停止任务，不能被协作兜底吞成成功。
    if (activeRun.controller.signal.aborted) throw error;
    const message = (error as Error).message;
    console.error("[协作] 派发失败:", message);
    // 协作失败已确定；兜底回复自身出错不能盖掉真实原因，也不能阻断会话收尾。
    await botRuntime.bot
      .reply(ctx.replyToMessageId, `协作派发失败：${message}`, ctx.replyInThread)
      .catch((replyError) =>
        console.error("[协作] 失败提示发送失败:", (replyError as Error).message),
      );
    return { outcome: "failed", failureReason: `协作派发失败：${message}` };
  }
}

/** 持久化或外部通知开始提交后不能承诺撤回；检查与锁定必须同步完成。 */
function beginTaskCommit(activeRun: ActiveRun): void {
  activeRun.controller.signal.throwIfAborted();
  activeRun.committing = true;
}

/** 下载消息里的图片与文件，失败不阻断任务。 */
export async function downloadMessageResources(
  botRuntime: BotRuntime,
  messageId: string,
  resources: Array<{ type: "image" | "file"; key: string; fileName?: string }>,
): Promise<void> {
  for (const resource of resources) {
    try {
      const savePath = await botRuntime.bot.downloadResource(
        messageId,
        resource.key,
        resource.type,
        join("data", "downloads"),
        resource.fileName,
      );
      console.log(`  [下载] ${resource.type} → ${savePath}`);
    } catch (error) {
      console.error(`  [下载失败] ${resource.key}:`, (error as Error).message);
    }
  }
}
