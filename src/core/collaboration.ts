/**
 * bot 之间的任务交接。
 * 飞书消息只负责把 dispatchId（取件码）送到目标 bot，
 * 真正要执行的任务内容存在这份共享收件箱里。
 */
import { z } from "zod";
import type { ToolCallLike } from "./clarification.js";

/** 显式派活与自动返回共用轮次上限，不能由某个调用入口自行决定是否检查。 */
export const CollaborationRoundSchema = z.object({
  round: z.number().int().positive(),
  maxRounds: z.number().int().positive(),
}).refine(({ round, maxRounds }) => round <= maxRounds);

export interface CollaborationMessage {
  /** 本次投递的取件码，出现在 @消息文本里。 */
  dispatchId: string;
  /** 贯穿整项协作，用于串起多轮交接。 */
  taskId: string;
  fromBotId: string;
  toBotId: string;
  /** 票据只在原群、原话题有效；取件码不能授权跨群或跨话题执行。 */
  chatId: string;
  threadId: string;
  /** 第几次 bot→bot 交接，用户首次派活不计入。 */
  round: number;
  maxRounds: number;
  workspaceDir: string;
  prompt: string;
}

/**
 * 去重键要认「这一次投递」，不能只认「这个话题的第几轮」。
 * 同一话题里先后两项任务派给同一个审查 bot 时，后者的键会和前者相同，
 * 于是第二次派活被当成重复消息丢掉。dispatchId 才是唯一标识。
 */
export function collaborationTurnKey(message: CollaborationMessage): string {
  return `${message.taskId}:${message.round}:${message.toBotId}:${message.dispatchId}`;
}

/** 上限：退回但始终没被重新领取的交接单不能无限堆积。 */
const MAX_PENDING = 200;

export class CollaborationInbox {
  private readonly messages = new Map<string, CollaborationMessage>();

  register(message: CollaborationMessage): void {
    this.messages.set(message.dispatchId, message);
    while (this.messages.size > MAX_PENDING) {
      const oldest = this.messages.keys().next().value;
      if (oldest === undefined) break;
      this.messages.delete(oldest);
      console.warn(`[协作] 收件箱已满，丢弃最早的待领取交接单: ${oldest}`);
    }
  }

  get size(): number {
    return this.messages.size;
  }

  /** 领取即删除：同一条派活通知不会被执行两次。 */
  consume(
    dispatchId: string,
    toBotId: string,
    delivery: { chatId: string; threadId: string; rootId?: string },
  ): CollaborationMessage | undefined {
    const message = this.messages.get(dispatchId);
    // 先验范围再删除：错误群里的重放不能烧掉正确话题尚未领取的票据。
    // 定时器用根消息 id 建会话，后续回复可能同时带 thread_id 与 root_id，二者都要认。
    if (!message || message.toBotId !== toBotId || !message.chatId || !message.threadId
      || message.chatId !== delivery.chatId
      || (message.threadId !== delivery.threadId && message.threadId !== delivery.rootId)) return undefined;
    this.messages.delete(dispatchId);
    return message;
  }

  /** 派发本身失败时撤销票据，不能伪装成一次正常领取来绕过范围校验。 */
  discard(dispatchId: string, toBotId: string): void {
    if (this.messages.get(dispatchId)?.toBotId === toBotId) this.messages.delete(dispatchId);
  }
}

/** Team Leader 用它把任务派给指定成员，取代写死的 reviewBy 关系。 */
export const dispatchTaskToolShape = {
  toBotId: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, "toBotId 必须是团队名册里的成员 id"),
  /** 交给对方执行的完整任务描述，接收方看不到你这一轮的上下文。 */
  task: z.string().trim().min(1).max(4_000),
  /** 需要对方在别的项目里干活时才填，留空沿用当前话题的工作目录。 */
  workspaceDir: z.string().trim().min(1).max(240).optional(),
};

export const DispatchTaskRequestSchema = z
  .object(dispatchTaskToolShape)
  .strict();

export type DispatchTaskRequest = z.infer<typeof DispatchTaskRequestSchema>;

export function findDispatchTaskRequest(
  toolCalls: ToolCallLike[] | undefined,
): DispatchTaskRequest | undefined {
  for (let index = (toolCalls?.length ?? 0) - 1; index >= 0; index -= 1) {
    const call = toolCalls?.[index];
    if (call?.toolName !== "dispatch_task") continue;
    const parsed = DispatchTaskRequestSchema.safeParse(call.input);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}
