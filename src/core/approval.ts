/**
 * 审批门：高危操作执行前必须由人拍板。
 * 和需求澄清同一套模式——Agent 调用工具后本轮结束，
 * Agent OS 展示审批卡，拿到结论后再续接原 CLI 会话。
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolCallLike } from "./clarification.js";

export const DEFAULT_APPROVAL_TIMEOUT_MINUTES = 30;

export const approvalToolShape = {
  title: z.string().trim().min(1).max(80),
  /** 要做什么，用人能判断的语言写。 */
  summary: z.string().trim().min(1).max(500),
  /** 影响范围：会动到哪些数据、服务或用户。 */
  impact: z.string().trim().min(1).max(500),
  /** 将要执行的确切命令，便于人核对。 */
  command: z.string().trim().max(500).optional(),
  risk: z.enum(["low", "medium", "high"]),
  timeoutMinutes: z.number().int().min(1).max(24 * 60).optional(),
};

export const ApprovalRequestSchema = z.object(approvalToolShape).strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export function findApprovalRequest(
  toolCalls: ToolCallLike[] | undefined,
): ApprovalRequest | undefined {
  for (let index = (toolCalls?.length ?? 0) - 1; index >= 0; index -= 1) {
    const call = toolCalls?.[index];
    if (call?.toolName !== "request_approval") continue;
    const parsed = ApprovalRequestSchema.safeParse(call.input);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface ApprovalFlow {
  token: string;
  taskId: string;
  botId: string;
  sessionId: string;
  /** 只有任务发起人可以拍板。 */
  ownerOpenId: string;
  ownerUnionId?: string;
  originalMessageId: string;
  /** 审批卡自己的 message_id：超时路径要靠它把卡片改成终态，收掉按钮。 */
  cardMessageId?: string;
  replyInThread: boolean;
  request: ApprovalRequest;
  status: ApprovalStatus;
  expiresAt: string;
  decidedAt?: string;
  decidedByOpenId?: string;
}

export type CreateApprovalFlowOptions = Omit<
  ApprovalFlow,
  "token" | "status" | "expiresAt" | "decidedAt" | "decidedByOpenId"
>;

export function isApprovalOwner(
  flow: Pick<ApprovalFlow, "ownerOpenId" | "ownerUnionId">,
  operator: { operatorOpenId: string; operatorUnionId?: string },
): boolean {
  if (flow.ownerUnionId && operator.operatorUnionId) {
    return flow.ownerUnionId === operator.operatorUnionId;
  }
  return flow.ownerOpenId === operator.operatorOpenId;
}

/** 拿到结论后交回开发者会话的续跑文本。 */
export function formatApprovalOutcome(flow: ApprovalFlow): string {
  if (flow.status === "approved") {
    return [
      `用户已经批准了这次高危操作：${flow.request.title}`,
      "现在可以执行它。执行后回报实际结果和影响范围。",
      "如果后续还有其他高危操作，必须再次调用 request_approval，不要合并批准。",
    ].join("\n\n");
  }
  if (flow.status === "rejected") {
    return [
      `用户拒绝了这次高危操作：${flow.request.title}`,
      "不要执行它，也不要寻找绕过的等价做法。",
      "请说明在不执行该操作的前提下还能推进到哪一步，以及需要用户补充什么。",
    ].join("\n\n");
  }
  return [
    `这次高危操作在等待期内没有得到批准：${flow.request.title}`,
    "视为未批准，不要执行它。",
    "请总结当前进度并说明还需要哪些确认。",
  ].join("\n\n");
}

export class ApprovalFlowStore {
  private readonly flows = new Map<string, ApprovalFlow>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  create(options: CreateApprovalFlowOptions): ApprovalFlow {
    const timeoutMinutes =
      options.request.timeoutMinutes ?? DEFAULT_APPROVAL_TIMEOUT_MINUTES;
    const flow: ApprovalFlow = {
      token: randomUUID().replaceAll("-", ""),
      ...options,
      status: "pending",
      expiresAt: new Date(
        this.now().getTime() + timeoutMinutes * 60_000,
      ).toISOString(),
    };
    this.flows.set(flow.token, flow);
    return flow;
  }

  get(token: string): ApprovalFlow | undefined {
    return this.flows.get(token);
  }

  /** 只有 pending 能被改写：重复点击、超时后再点都不会改变结论。 */
  decide(
    token: string,
    decision: "approved" | "rejected" | "expired",
    decidedByOpenId?: string,
  ): ApprovalFlow | undefined {
    const flow = this.flows.get(token);
    if (!flow || flow.status !== "pending") return undefined;
    flow.status = decision;
    flow.decidedAt = this.now().toISOString();
    if (decidedByOpenId) flow.decidedByOpenId = decidedByOpenId;
    return flow;
  }

  /**
   * 结论没能送达 CLI 时把它退回待处理，卡片上的按钮重新可用。
   * 否则 flow 既不是 pending 也没人删，会永远泄漏，用户也没有任何重试入口。
   */
  revertToPending(token: string): ApprovalFlow | undefined {
    const flow = this.flows.get(token);
    if (!flow || flow.status === "pending") return undefined;
    flow.status = "pending";
    delete flow.decidedAt;
    delete flow.decidedByOpenId;
    return flow;
  }

  delete(token: string): void {
    this.flows.delete(token);
  }
}
