/**
 * 卡片按钮回调。
 * 只校验这次点击是否合法并更新状态，真正的执行交给任务主线，
 * 回调本身要尽快返回，否则飞书侧会超时。
 */
import {
  buildApprovalCard,
  buildApprovalDecidedCard,
  buildClarificationCard,
  buildClarificationContinuingCard,
  buildProductSpecApprovedCard,
  buildProductSpecExpiredCard,
  buildResumeCard,
  buildScheduleListCard,
  buildSessionNoticeCard,
} from "../im/card.js";
import type { CardAction, CardActionResponse } from "../im/lark.js";
import {
  filterResumableSessions,
  listNativeCliSessions,
} from "../cli/native-sessions.js";
import type { BotConfig } from "../core/bot-registry.js";
import { isBotRequestAllowed } from "../core/access-control.js";
import { ensureAllowedWorkspace } from "../core/workspace.js";
import { isApprovalOwner } from "../core/approval.js";
import {
  formatClarificationAnswers,
  isClarificationOwner,
} from "../core/clarification.js";
import { isProductSpecOwner } from "../core/product-spec.js";
import { abortScheduleRuns, requestTaskAbort } from "../core/task-abort.js";
import { parseTaskHistoryFilter } from "../core/task-record.js";
import type { Schedule } from "../core/schedule.js";
import { renderHistoryDetail, renderHistoryPage } from "./history-view.js";
import { resumeAfterApproval, resumeSession } from "./task-runner.js";
import type { AppRuntime } from "./runtime.js";

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 按钮里的页码是外部输入：非数字一律回到第一页，越界交给查询自己收敛。 */
function readPage(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  const parsed = Number.parseInt(readString(value), 10);
  return Number.isNaN(parsed) ? 1 : parsed;
}

/**
 * 定时任务操作的作用域校验。和历史卡同一套思路：卡片可以被转发，
 * 回调里的 botId / chatId / scheduleId 全是外部输入。
 * 两道都要过——先看卡片自称的作用域和回调实际发生的位置是否一致，
 * 再看那条任务自己的归属，只信任存储里的值。
 */
function resolveOwnSchedule(options: {
  action: CardAction;
  runtime: AppRuntime;
  botId: string;
}): { schedule: Schedule } | { denied: CardActionResponse } {
  const { action, runtime, botId } = options;
  if (readString(action.value.botId) !== botId) {
    return {
      denied: {
        toast: { type: "error", content: "这张定时任务卡片属于另一台机器人。" },
      },
    };
  }
  const cardChatId = readString(action.value.chatId);
  if (!action.chatId || cardChatId !== action.chatId) {
    console.warn(
      `[定时] 操作请求的群与回调位置不一致，已拒绝：卡片=${cardChatId || "(空)"} 回调=${action.chatId || "(空)"}`,
    );
    return {
      denied: {
        toast: { type: "error", content: "这张卡片来自别的群，请回原群操作。" },
      },
    };
  }
  const scheduleId = readString(action.value.scheduleId);
  const schedule = runtime.schedules.get(scheduleId);
  // 存储里的归属才算数：回调里的 botId/chatId 是卡片自称的，改得动。
  if (!schedule || schedule.botId !== botId || schedule.chatId !== action.chatId) {
    return {
      denied: {
        toast: { type: "warning", content: "这条定时任务已经不在了，列表已刷新。" },
      },
    };
  }
  return { schedule };
}

/**
 * 历史卡片（列表与详情）共用的作用域校验。按钮里的 botId / chatId 是卡片自带的数据，
 * 不是身份：卡片能被转发到别的群，所以每次都要和「这次点击实际发生在哪里」对齐。
 * 返回值非空就代表这次点击不该看到任何记录内容——连一条摘要都不能渲染。
 */
function rejectForeignHistoryScope(options: {
  action: CardAction;
  botId: string;
  /** 只用于日志，区分被拒的是翻页还是详情。 */
  kind: string;
}): CardActionResponse | undefined {
  const { action, botId, kind } = options;
  if (readString(action.value.botId) !== botId) {
    return {
      toast: {
        type: "error",
        content: "这张历史卡片属于另一台机器人，请找它查看。",
      },
    };
  }
  const cardChatId = readString(action.value.chatId);
  if (!action.chatId || cardChatId !== action.chatId) {
    // 群 id 缺失时同样不渲染：校验不了来源就等于没有校验。
    console.warn(
      `[历史] ${kind}请求的群与回调位置不一致，已拒绝：卡片=${cardChatId || "(空)"} 回调=${action.chatId || "(空)"}`,
    );
    return {
      toast: {
        type: "error",
        content: "这张历史卡片不是本群的，请在原群里查看，或重新发一次 /history。",
      },
    };
  }
  return undefined;
}

export function createCardActionHandler(options: {
  runtime: AppRuntime;
  config: BotConfig;
}): (action: CardAction) => Promise<CardActionResponse | undefined> {
  const { runtime, config } = options;

  const ownsSession = (sessionId: string, chatId: string): boolean => {
    const session = runtime.sessions.get(sessionId);
    return !!session && session.botId === config.id && session.chatId === chatId;
  };

  return async (action) => {
    if (!isBotRequestAllowed(config, action.operatorOpenId, action.chatId)) {
      return { toast: { type: "warning", content: "当前账号或聊天未获授权，请联系管理员配置访问名单。" } };
    }
    const actionName = readString(action.value.action);

    if (actionName === "approve_product_spec") {
      const flow = runtime.productSpecFlows.get(readString(action.value.flowToken));
      if (!flow || flow.botId !== config.id || !action.messageId || !ownsSession(flow.sessionId, action.chatId)) {
        return { toast: { type: "error", content: "这份产品方案已经失效。" } };
      }
      if (flow.status === "expired") {
        return {
          toast: { type: "warning", content: "这份产品方案已经失效。" },
          card: { type: "raw", data: buildProductSpecExpiredCard(flow) },
        };
      }
      if (flow.status === "approved") {
        return {
          toast: { type: "info", content: "产品方案已经确认。" },
          card: { type: "raw", data: buildProductSpecApprovedCard(flow) },
        };
      }
      if (!isProductSpecOwner(flow, action)) {
        return { toast: { type: "warning", content: "只有任务发起人可以确认。" } };
      }
      const productSession = runtime.sessions.get(flow.sessionId);
      if (!productSession || productSession.status === "closed") {
        return { toast: { type: "error", content: "对应的产品会话已经失效，请重新发起方案评审。" } };
      }
      // 评论先同步占位再检查目录；只看异步落盘的 active 会放过准备期间的确认。
      if (productSession.status !== "idle" || runtime.activeRuns.has(productSession.id) || runtime.sessions.isUpdating(productSession.id)) {
        return { toast: { type: "warning", content: "方案仍在修改或会话正在准备，请等本轮结束并复查文档后再确认。" } };
      }
      let approved;
      try {
        approved = runtime.productSpecFlows.approve(flow.token);
      } catch (error) {
        console.error("[产品] 确认状态保存失败:", (error as Error).message);
        return { toast: { type: "error", content: "方案确认未能保存，请稍后重试。原方案仍待确认。" } };
      }
      if (!approved) {
        return { toast: { type: "warning", content: "方案状态已经更新。" } };
      }
      return {
        toast: { type: "success", content: "产品方案已确认。" },
        card: { type: "raw", data: buildProductSpecApprovedCard(approved) },
      };
    }

    if (actionName === "decide_approval") {
      const token = readString(action.value.flowToken);
      const decision = readString(action.value.decision);
      const flow = runtime.approvalFlows.get(token);
      if (!flow || flow.botId !== config.id || !ownsSession(flow.sessionId, action.chatId)) {
        return { toast: { type: "error", content: "这条审批请求已经失效。" } };
      }
      if (flow.status !== "pending") {
        return {
          toast: { type: "info", content: "这条审批已经处理过了。" },
          card: { type: "raw", data: buildApprovalDecidedCard(flow) },
        };
      }
      if (!isApprovalOwner(flow, action)) {
        return { toast: { type: "warning", content: "只有任务发起人可以拍板。" } };
      }
      if (decision !== "approved" && decision !== "rejected") {
        return { toast: { type: "error", content: "无法识别的审批结论。" } };
      }
      // 先确认会话能接住结论，再落状态。反过来的话，会话正忙时结论已经写死，
      // 卡片却宣称「将继续执行」，而 CLI 永远收不到这个结论。
      const approvalSession = runtime.sessions.get(flow.sessionId);
      if (!approvalSession || approvalSession.status === "closed") {
        return { toast: { type: "error", content: "对应的 CLI 会话已经失效。" } };
      }
      // activeRuns 是同步占位，会话状态是异步落盘：两个都要看，
      // 否则占位之后、transition 落盘之前的那个窗口会被放过去。
      if (
        approvalSession.status === "active" ||
        runtime.activeRuns.has(approvalSession.id) || runtime.sessions.isUpdating(approvalSession.id)
      ) {
        return {
          toast: { type: "warning", content: "当前会话仍在执行，请稍后再点一次。" },
        };
      }
      const decided = runtime.approvalFlows.decide(
        token,
        decision,
        action.operatorOpenId,
      );
      if (!decided) {
        return {
          toast: { type: "info", content: "审批状态已经更新。" },
          card: { type: "raw", data: buildApprovalCard(flow) },
        };
      }
      const botRuntime = runtime.botRuntimes.get(config.id);
      if (botRuntime) {
        // 拍板后恢复开发者会话，让它按结论继续或停止。
        queueMicrotask(() => {
          void resumeAfterApproval(runtime, botRuntime, token).catch((error) => {
            console.error("[审批] 恢复会话失败:", (error as Error).message);
          });
        });
      }
      return {
        toast: {
          type: decision === "approved" ? "success" : "info",
          content: decision === "approved" ? "已批准。" : "已拒绝。",
        },
        card: { type: "raw", data: buildApprovalDecidedCard(decided) },
      };
    }

    if (actionName === "answer_clarification") {
      const flowToken = readString(action.value.flowToken);
      const questionId = readString(action.value.questionId);
      const flow = runtime.clarificationFlows.get(flowToken);
      if (!flow || flow.botId !== config.id || !action.messageId || !ownsSession(flow.sessionId, action.chatId)) {
        return { toast: { type: "error", content: "这组澄清问题已经失效。" } };
      }
      if (!isClarificationOwner(flow, action)) {
        return { toast: { type: "warning", content: "只有任务发起人可以回答。" } };
      }

      const question = flow.request.questions[flow.currentIndex];
      if (!question || question.id !== questionId) {
        return {
          toast: { type: "warning", content: "问题已经更新，请按当前卡片作答。" },
        };
      }

      const decisionMode =
        action.value.decisionMode === "current" ||
        action.value.decisionMode === "remaining"
          ? action.value.decisionMode
          : undefined;

      // 这一下会不会答完最后一题？会的话先确认会话能接住，
      // 否则答案已经落库、currentIndex 越界，卡片就永久卡死了。
      const finishesFlow =
        decisionMode === "remaining" ||
        flow.currentIndex === flow.request.questions.length - 1;
      const botRuntime = runtime.botRuntimes.get(config.id);
      const session = runtime.sessions.get(flow.sessionId);
      if (finishesFlow) {
        if (!botRuntime || !session || session.status === "closed") {
          return { toast: { type: "error", content: "对应的 CLI 会话已经失效。" } };
        }
        if (session.status === "active" || runtime.activeRuns.has(session.id) || runtime.sessions.isUpdating(session.id)) {
          return {
            toast: { type: "warning", content: "当前会话仍在执行，请稍后再点一次。" },
          };
        }
      }

      let answered;
      if (decisionMode) {
        answered = runtime.clarificationFlows.answerWithRecommendation(
          flowToken,
          decisionMode === "remaining",
        );
      } else {
        const custom = action.value.custom === true;
        const optionId = readString(action.value.optionId);
        const selected = question.options.find((option) => option.id === optionId);
        const customAnswer =
          typeof action.formValue.custom_answer === "string"
            ? action.formValue.custom_answer.trim()
            : "";
        const answer = custom ? customAnswer : (selected?.label ?? "");
        if (!answer) {
          return {
            toast: {
              type: "warning",
              content: custom ? "请先输入你的答案。" : "这个选项已经失效。",
            },
          };
        }
        answered = runtime.clarificationFlows.answer(flowToken, questionId, answer);
      }

      if (!answered) {
        return { toast: { type: "warning", content: "答案没有保存，请重试。" } };
      }
      console.log(
        `[澄清] 收到第 ${answered.flow.answers.length}/${answered.flow.request.questions.length} 题答案`,
      );
      if (!answered.complete) {
        return {
          toast: { type: "success", content: "已记录，继续下一题。" },
          card: { type: "raw", data: buildClarificationCard({ flow: answered.flow }) },
        };
      }

      if (!botRuntime) {
        return { toast: { type: "error", content: "对应的 bot 尚未就绪。" } };
      }

      const completed = answered.flow;
      // 先把 toast 和新卡片交回飞书，CLI 在后台继续。
      queueMicrotask(() => {
        void resumeSession({
          runtime,
          botRuntime,
          sessionId: completed.sessionId,
          taskId: completed.taskId,
          replyToMessageId: completed.originalMessageId,
          replyInThread: completed.replyInThread,
          ownerOpenId: completed.ownerOpenId,
          ...(completed.ownerUnionId
            ? { ownerUnionId: completed.ownerUnionId }
            : {}),
          text: formatClarificationAnswers(completed),
        })
          .then(() => {
            // 送达之后才销毁，和审批路径同一条约定。
            runtime.clarificationFlows.delete(completed.token);
          })
          .catch(async (error) => {
            const message = (error as Error).message;
            console.error("[澄清] 继续执行失败:", message);
            // 流程留着：用户在同话题补一句话时，index.ts 仍能把已确认的答案带回去。
            if (action.messageId) {
              await botRuntime.bot
                .updateCard(
                  action.messageId,
                  buildSessionNoticeCard({
                    title: `${completed.request.title} · 未能继续`,
                    template: "red",
                    detail: [
                      `答案已经记下，但没能交给执行引擎：${message}`,
                      "直接在本话题里再说一句话即可继续，已确认的答案会一并带上。",
                    ].join("\n\n"),
                  }),
                )
                .catch(() => undefined);
            }
          });
      });

      return {
        toast: { type: "success", content: "答案已收到。" },
        card: { type: "raw", data: buildClarificationContinuingCard(completed) },
      };
    }

    if (actionName === "history_page") {
      const denied = rejectForeignHistoryScope({
        action,
        botId: config.id,
        kind: "翻页",
      });
      if (denied) return denied;
      // 校验通过后，按钮里的群和回调发生的群已经确认一致，用可信的那一个取数。
      const requestedChatId = action.chatId;

      const requestedPage = readPage(action.value.page);
      // 筛选值和页码一样是按钮里的普通数据：在这道边界上用 Zod 收敛成合法档位，
      // 认不出来的当「全部」，内核只接已验证的值。
      const requestedFilter = parseTaskHistoryFilter(action.value.filter);
      const { card, page } = renderHistoryPage({
        runtime,
        botId: config.id,
        chatId: requestedChatId,
        page: requestedPage,
        filter: requestedFilter,
      });
      console.log(
        `[历史] 翻页 chat=${requestedChatId} bot=${config.id} 筛选=${page.filter} 请求第 ${requestedPage} 页，展示第 ${page.page}/${page.pageCount} 页`,
      );
      // 原地换卡片，不新发消息：历史是一块可以来回翻的面板，不该在群里刷屏。
      if (page.page !== requestedPage) {
        // 越界收敛：期间旧记录被滚动丢弃，或卡片本身已经过时，要说清为什么不是点的那一页。
        return {
          toast: {
            type: "info",
            content: `这一页已经不存在了，显示第 ${page.page}/${page.pageCount} 页。`,
          },
          card: { type: "raw", data: card },
        };
      }
      return { card: { type: "raw", data: card } };
    }

    if (actionName === "history_detail") {
      const denied = rejectForeignHistoryScope({
        action,
        botId: config.id,
        kind: "详情",
      });
      if (denied) return denied;
      const chatId = action.chatId;
      const recordId = readString(action.value.recordId);
      // 来源页码和筛选跟翻页按钮一样是普通数据，先收敛成合法值再原样交给「返回列表」。
      const sourcePage = readPage(action.value.page);
      const sourceFilter = parseTaskHistoryFilter(action.value.filter);
      const detail = renderHistoryDetail({
        runtime,
        botId: config.id,
        chatId,
        recordId,
        page: sourcePage,
        filter: sourceFilter,
      });
      if (!detail) {
        // 记录被滚动挤出保留范围是正常结局：不回 card，用户眼前那张列表原样留着，
        // 还能接着翻别的记录；报一张错误卡片反而把他手上的浏览进度打断了。
        console.log(
          `[历史] 详情记录已不在保留范围 chat=${chatId} bot=${config.id} record=${recordId || "(空)"}`,
        );
        return {
          toast: {
            type: "warning",
            content: "这条记录已经不在保留范围内，列表里更近的任务仍然打得开。",
          },
        };
      }
      console.log(
        `[历史] 详情 chat=${chatId} bot=${config.id} record=${detail.record.id} 状态=${detail.record.status} 来源第 ${sourcePage} 页/${sourceFilter}`,
      );
      // 原地换成详情视图：列表和详情是同一张卡片的两面，不该在群里再刷一条消息。
      return { card: { type: "raw", data: detail.card } };
    }

    if (
      actionName === "schedule_toggle" ||
      actionName === "schedule_delete" ||
      actionName === "schedule_delete_cancel"
    ) {
      const resolved = resolveOwnSchedule({ action, runtime, botId: config.id });
      if ("denied" in resolved) {
        // 只回 toast，不回卡片——和 rejectForeignHistoryScope 一个规矩。
        // 校验没过却顺手渲染一张列表，等于「拒绝了你，但还是把内容给你看了」：
        // 卡片可能正躺在别的群里，那一刷就把本群的任务名、cron、上次错误送了过去。
        return resolved.denied;
      }
      const { schedule } = resolved;
      // 走到这里作用域已经校验通过，用回调所在群渲染是安全的。
      const listCard = (over: { pendingDeleteId?: string; armedBy?: string } = {}) =>
        buildScheduleListCard(
          runtime.schedules.listForScope(config.id, action.chatId),
          { botId: config.id, chatId: action.chatId, ...over },
        );

      if (actionName === "schedule_delete_cancel") {
        return { card: { type: "raw", data: listCard() } };
      }

      if (actionName === "schedule_delete") {
        // 删除不可撤销：第一次点只把按钮换成「确认删除」，第二次才真删。
        if (action.value.confirmed !== true) {
          return {
            card: {
              type: "raw",
              data: listCard({
                pendingDeleteId: schedule.id,
                armedBy: action.operatorOpenId,
              }),
            },
          };
        }
        // 卡片是群里共享的：谁点开的确认，只有谁能落这一刀。
        // 不绑人的话，甲点开「确认删除」之后，对乙来说就成了一点就删。
        if (readString(action.value.armedBy) !== action.operatorOpenId) {
          return {
            toast: {
              type: "warning",
              content: "这一步得由点开确认的那个人来点。",
            },
            card: { type: "raw", data: listCard() },
          };
        }
        // 落盘可能失败（磁盘满、权限、临时文件重命名失败）。不接住的话
        // 异常会一路抛回飞书 SDK，用户点完什么反馈都没有，只当卡片坏了。
        // 先删记录再中止本轮，顺序不能反：反过来的话删除写盘失败时用户收到
        // 「没能删掉」，可那一轮已经被停了，回执又和实际对不上。
        try {
          await runtime.schedules.remove(schedule.id);
        } catch (error) {
          console.error("[定时] 删除写盘失败:", (error as Error).message);
          return {
            toast: { type: "error", content: "没能删掉，磁盘写入失败，请稍后再试。" },
            card: { type: "raw", data: listCard() },
          };
        }
        // 摘掉存储记录只是让它不再触发，已经跑起来的那一轮不会自己停下来。
        // 不中止的话回执说「已删除」，引擎却还在按这条已经不存在的任务改用户的文件。
        const running = abortScheduleRuns(runtime.activeRuns, schedule.id);
        console.log(
          `[定时] 已删除 id=${schedule.id} name=${schedule.name} bot=${config.id} 本轮=${running}`,
        );
        return {
          toast: {
            type: "success",
            // 中止是发信号，进程树要几秒才真的退出，所以说「正在停止」而不是「已停止」。
            content:
              running === "not_running"
                ? `已删除「${schedule.name}」。`
                : `已删除「${schedule.name}」，正在停止本轮执行。`,
          },
          card: { type: "raw", data: listCard() },
        };
      }

      // 目标状态由按钮带回来，不在这里对当前值取反：
      // 取反的话，一张落后于存储的旧卡上写着「停用」的按钮，点下去是启用。
      const enabled = action.value.enabled === true;
      try {
        await runtime.schedules.update(schedule.id, { enabled });
      } catch (error) {
        console.error("[定时] 启停写盘失败:", (error as Error).message);
        return {
          toast: { type: "error", content: "没能改过来，磁盘写入失败，请稍后再试。" },
          card: { type: "raw", data: listCard() },
        };
      }
      console.log(
        `[定时] ${enabled ? "已启用" : "已停用"} id=${schedule.id} name=${schedule.name} bot=${config.id}`,
      );
      return {
        toast: {
          type: "success",
          content: `${enabled ? "已启用" : "已停用"}「${schedule.name}」。`,
        },
        card: { type: "raw", data: listCard() },
      };
    }

    if (actionName === "resume_cli_session") {
      const agentSessionId = readString(action.value.agentSessionId);
      const cliSessionId = readString(action.value.cliSessionId);
      const session = runtime.sessions.get(agentSessionId);
      if (!session || session.botId !== config.id || !cliSessionId || !ownsSession(session.id, action.chatId)) {
        return { toast: { type: "error", content: "这条会话记录已经失效。" } };
      }
      if (session.status === "active" || runtime.activeRuns.has(session.id)) {
        return {
          toast: { type: "warning", content: "当前任务结束后才能切换会话。" },
        };
      }
      if (session.status === "closed") {
        return { toast: { type: "warning", content: "当前话题的会话已经关闭。" } };
      }
      try {
        await ensureAllowedWorkspace(session.workspaceDir, config);
        const cliAdapter = runtime.getAdapter(session.cliId);
        // 这里也要过滤：只在列表里藏起来没用，按钮里塞一个 id 照样能恢复。
        const nativeSessions = filterResumableSessions(
          await listNativeCliSessions({
            adapter: cliAdapter,
            cwd: session.workspaceDir,
            scope: config.resumeScope,
          }),
          config.resumeScope,
        );
        // 按钮传回来的 ID 不能直接相信，重新确认它仍在当前工作目录里。
        if (!nativeSessions.some((item) => item.id === cliSessionId)) {
          return {
            toast: {
              type: "error",
              content: "这个 CLI 会话已经不在当前工作目录中。",
            },
          };
        }
        // 原生历史读取是异步的，返回时会话可能已被任务占用或切到了别的项目。
        const current = runtime.sessions.get(session.id);
        if (!current || current.status === "closed" || current.status === "active" || runtime.activeRuns.has(session.id) || runtime.sessions.isUpdating(session.id)
          || current.workspaceDir !== session.workspaceDir || current.cliSessionId !== session.cliSessionId) {
          return { toast: { type: "warning", content: "会话正在执行或已经更新，请稍后重新打开恢复列表。" } };
        }
        const updated = await runtime.sessions.setCliSessionId(
          session.id,
          cliSessionId,
        );
        return {
          toast: { type: "success", content: "已切换到选中的历史会话。" },
          card: {
            type: "raw",
            data: buildResumeCard({
              agentSessionId: updated.id,
              cliName: cliAdapter.displayName,
              ...(updated.cliSessionId
                ? { currentCliSessionId: updated.cliSessionId }
                : {}),
              sessions: nativeSessions,
            }),
          },
        };
      } catch (error) {
        // 原始异常里常带英文栈文本和本机绝对路径，不适合直接出现在 toast 里。
        console.error("[会话] 恢复历史会话失败:", (error as Error).message);
        return {
          toast: {
            type: "error",
            content: "读取历史会话失败，请稍后重试或改用 /new 开启新会话。",
          },
        };
      }
    }

    if (actionName !== "abort_task") return undefined;

    const sessionId = readString(action.value.sessionId);
    if (runtime.activeRuns.has(sessionId) && !ownsSession(sessionId, action.chatId)) {
      return { toast: { type: "warning", content: "请在任务所属的聊天中停止任务。" } };
    }

    const outcome = requestTaskAbort(
      runtime.activeRuns,
      sessionId,
      action.operatorOpenId,
    );
    if (outcome === "not_found") {
      return { toast: { type: "info", content: "任务已经结束，无需再次停止。" } };
    }
    if (outcome === "forbidden") {
      return { toast: { type: "warning", content: "只有任务发起人可以停止它。" } };
    }
    if (outcome === "already_stopping") {
      return { toast: { type: "info", content: "正在停止任务，请稍候。" } };
    }
    if (outcome === "committing") {
      return { toast: { type: "info", content: "本轮结果已开始提交，无法撤回。请等待上方卡片更新。" } };
    }
    return { toast: { type: "success", content: "已发送停止指令。" } };
  };
}
