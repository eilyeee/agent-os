/** 把飞书话题折算成稳定的任务编号，卡片回调和文字补充都能回到同一项任务。 */
import { createHash, randomUUID } from "node:crypto";

export interface TopicAddress {
  messageId: string;
  chatId: string;
  threadId: string;
  rootId: string;
}

/**
 * threadId 标记话题本身，rootId 指向话题首条消息；两者都没有说明这条消息
 * 不属于任何话题（普通群或单聊），此时用它自己的 messageId 起一个话题。
 */
export function topicIdOf(message: TopicAddress): string {
  return message.threadId || message.rootId || message.messageId;
}

/**
 * **话题**的稳定标识：同一个飞书话题永远得到同一个值。
 *
 * 它一度被叫作 topicTaskId 并直接当成「任务编号」用，于是同一个话题里
 * 两件毫不相干的事共用一个编号，四台 bot 各自的执行也共用一个编号——
 * 而这个值还印在卡片上给用户看。**话题不是任务。**
 * 需要「这个话题里有没有待办的某某」时用它；需要标识一件事时用 newTaskId()。
 */
export function topicScopeId(message: TopicAddress): string {
  return createHash("sha256")
    .update(`${message.chatId}:${topicIdOf(message)}`)
    .digest("hex")
    .slice(0, 24);
}

/**
 * 一件事的标识：用户发起一次请求、或定时器触发一次，就是一件事。
 * 它之后的所有轮次——交接给队友、审批拍板后续跑、澄清答完续跑——都沿用同一个值，
 * 这样历史里才能把一件事的来龙去脉串起来，而不是四条互不相干的流水。
 */
export function newTaskId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 24);
}

/**
 * 从已经落好的会话反推话题标识。会话的 threadId 本身就是 topicIdOf() 的结果，
 * 所以这和对原始消息调 topicScopeId() 等价。
 * 有了它，需要话题标识的地方就不必在每个调用点各传一次——
 * 传的地方越多，漏传一处的机会就越多。
 */
export function topicScopeIdOf(chatId: string, threadId: string): string {
  return createHash("sha256")
    .update(`${chatId}:${threadId}`)
    .digest("hex")
    .slice(0, 24);
}
