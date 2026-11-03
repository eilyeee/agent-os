/** 人员与群的准入规则：没有显式授权时不启动无人值守引擎。 */
import type { BotConfig } from "./bot-registry.js";

type AccessPolicy = Pick<BotConfig, "ownerOpenId" | "allowedUserOpenIds" | "allowedChatIds">;

export function isUserAllowed(config: AccessPolicy, openId: string): boolean {
  // 显式空名单表示停用访问，不能再回退负责人。
  const allowed = config.allowedUserOpenIds ?? (config.ownerOpenId ? [config.ownerOpenId] : []);
  return !!openId && allowed.includes(openId);
}

export function isChatAllowed(config: AccessPolicy, chatId: string): boolean {
  return !!chatId && (config.allowedChatIds === undefined || config.allowedChatIds.includes(chatId));
}

export function isBotRequestAllowed(config: AccessPolicy, openId: string, chatId: string): boolean {
  return isUserAllowed(config, openId) && isChatAllowed(config, chatId);
}
