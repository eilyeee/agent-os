/** bot 之间的派活：先登记交接单，再用卡片说明 + 新消息真正 @ 到对方。 */
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { buildCollaborationCard } from "../im/card.js";
import type { CollaborationMessage } from "../core/collaboration.js";
import { spentOnTask } from "../core/task-record.js";
import { ensureAllowedWorkspace } from "../core/workspace.js";
import { isBotRequestAllowed } from "../core/access-control.js";
import type { AppRuntime, BotRuntime } from "./runtime.js";

export interface SendCollaborationOptions {
  runtime: AppRuntime;
  sender: BotRuntime;
  replyToMessageId: string;
  chatId: string;
  threadId: string;
  targetBotId: string;
  taskId: string;
  kind: "forward" | "return";
  round: number;
  maxRounds: number;
  workspaceDir: string;
  prompt: string;
  /**
   * 刚跑完这一轮花掉的 token。
   * 必须显式传：发交接单发生在本轮记录落盘**之前**，
   * 只查历史的话看不到刚烧掉的这一轮——而失控往往就是从这一轮开始的。
   */
  spentThisTurn?: number;
}

/**
 * 预算卡在**发交接单这一步**，不是收的那一步：不发就不用回滚收件箱，
 * 也不用担心交接单被认领之后凭空消失。三条交接路径
 * （自动互审、返回结果、dispatch_task 派活）都汇到这里，一处就够。
 *
 * 只拦自动续跑，不拦人：人发的新消息是新的一件事，从零开始计；
 * 人拍板后的续跑走的是 resumeSession，不经过这里。
 */
export async function sendCollaborationMessage(
  options: SendCollaborationOptions,
): Promise<boolean> {
  const target = options.runtime.botRuntimes.get(options.targetBotId);
  if (!target) throw new Error(`协作 bot 尚未就绪: ${options.targetBotId}`);
  if (!options.threadId || !isBotRequestAllowed(target.config, target.config.ownerOpenId ?? "", options.chatId)) {
    throw new Error("目标机器人的负责人或交接范围未获授权，请检查访问名单和原话题。");
  }
  await ensureAllowedWorkspace(options.workspaceDir, target.config);

  const budget = options.sender.config.maxTokensPerTask;
  const spent =
    spentOnTask(options.runtime.taskRecords.list(), options.taskId) +
    (options.spentThisTurn ?? 0);
  if (spent >= budget) {
    console.warn(
      `[协作] 预算用尽，不再自动续跑 task=${options.taskId} 已花 ${spent} / 上限 ${budget}`,
    );
    await options.sender.bot.reply(
      options.replyToMessageId,
      [
        `这件事已经花掉 ${formatTokens(spent)} tokens，达到单件上限（${formatTokens(budget)}），`,
        `我停在这里，没有继续派给 ${options.targetBotId}。`,
        "要接着做的话，直接跟我说一句就行——那会作为新的一件事重新开始计。",
      ].join("\n"),
      true,
    );
    return false;
  }

  const collaboration: CollaborationMessage = {
    // 取件码：飞书消息只带它，真正的任务内容留在收件箱里。
    dispatchId: randomUUID().replaceAll("-", "").slice(0, 12),
    taskId: options.taskId,
    fromBotId: options.sender.config.id,
    toBotId: options.targetBotId,
    chatId: options.chatId,
    threadId: options.threadId,
    round: options.round,
    maxRounds: options.maxRounds,
    workspaceDir: options.workspaceDir,
    prompt: options.prompt,
  };
  options.runtime.collaborationInbox.register(collaboration);

  try {
    const cardMessageId = await options.sender.bot.replyCard(
      options.replyToMessageId,
      buildCollaborationCard({
        senderName: options.sender.identity.name,
        targetName: target.identity.name,
        workspaceName: basename(options.workspaceDir),
        prompt: options.prompt,
        kind: options.kind,
        round: options.round,
        maxRounds: options.maxRounds,
      }),
      true,
    );
    if (!cardMessageId) throw new Error("飞书没有返回协作卡片 message_id");

    // 更新卡片不会触发 @提及通知，必须再发一条新消息才能真正点到对方。
    const mentionMessageId = await options.sender.bot.replyMention(
      cardMessageId,
      target.identity,
      options.kind === "forward"
        ? `新任务已派发（任务编号：${collaboration.dispatchId}），请查看上方卡片。`
        : `结果已经返回（任务编号：${collaboration.dispatchId}），请查看上方卡片。`,
      true,
    );
    if (!mentionMessageId) throw new Error("飞书没有返回协作通知 message_id");
  } catch (error) {
    // 派发没成功就撤回交接单，避免收件箱里留下永远不会被领取的任务。
    options.runtime.collaborationInbox.discard(
      collaboration.dispatchId,
      collaboration.toBotId,
    );
    throw error;
  }

  console.log(
    `[协作] task=${options.taskId} ${options.sender.config.id} -> ${options.targetBotId} round=${options.round}/${options.maxRounds}`,
  );
  return true;
}

/** 给人看的量级：几百万的原始数字读不出感觉。 */
function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}
