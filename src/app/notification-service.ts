/** 结果通知。卡片承载完整结果，通知只负责把人叫回来看。 */
import type { Bot, BotIdentity } from "../im/lark.js";

export async function sendResultNotification(options: {
  bot: Bot;
  replyToMessageId: string;
  target: BotIdentity;
  text: string;
  replyInThread: boolean;
}): Promise<void> {
  // 定时任务等系统发起的场景可能没有配置 OWNER_OPEN_ID，空 openId 调接口必然失败。
  if (!options.target.openId) {
    console.warn("[通知] 没有可点名的接收人，已跳过。检查 .env 里的 OWNER_OPEN_ID");
    return;
  }
  try {
    await options.bot.replyMention(
      options.replyToMessageId,
      options.target,
      options.text,
      options.replyInThread,
    );
  } catch (error) {
    // 通知失败不能影响任务本身的收尾。
    console.error("[通知] 结果通知发送失败:", (error as Error).message);
  }
}
