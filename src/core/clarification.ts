/** 需求澄清：问题结构的参数契约 + 逐题回答的流程状态。 */
import { randomUUID } from "node:crypto";
import { z } from "zod";

const IdSchema = z.string().regex(/^[a-z0-9_-]{1,32}$/);

const OptionSchema = z.object({
  id: IdSchema,
  label: z.string().trim().min(1).max(100),
});

const QuestionSchema = z
  .object({
    id: IdSchema,
    prompt: z.string().trim().min(1).max(300),
    options: z.array(OptionSchema).min(2).max(4),
    recommendedOptionId: IdSchema.optional(),
  })
  .superRefine((question, ctx) => {
    const optionIds = question.options.map((option) => option.id);
    if (new Set(optionIds).size !== optionIds.length) {
      ctx.addIssue({
        code: "custom",
        message: "同一道问题的选项 ID 不能重复",
        path: ["options"],
      });
    }
    if (
      question.recommendedOptionId &&
      !optionIds.includes(question.recommendedOptionId)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "推荐项必须指向当前问题中的选项",
        path: ["recommendedOptionId"],
      });
    }
  });

/** MCP 的 inputSchema 只接受原始 shape，跨字段校验留在完整 Schema 里。 */
export const clarificationToolShape = {
  title: z.string().trim().min(1).max(80).default("需求澄清"),
  intro: z.string().trim().max(300).optional().default(""),
  questions: z.array(QuestionSchema).min(1).max(5),
};

export const ClarificationRequestSchema = z
  .object(clarificationToolShape)
  .superRefine((request, ctx) => {
    const questionIds = request.questions.map((question) => question.id);
    if (new Set(questionIds).size !== questionIds.length) {
      ctx.addIssue({
        code: "custom",
        message: "同一份澄清请求的问题 ID 不能重复",
        path: ["questions"],
      });
    }
  });

export type ClarificationRequest = z.infer<typeof ClarificationRequestSchema>;

export interface ToolCallLike {
  toolName: string;
  input: unknown;
}

/** 从本轮工具调用里取最近一次合法的澄清请求。 */
export function findClarificationRequest(
  toolCalls: ToolCallLike[] | undefined,
): ClarificationRequest | undefined {
  for (let index = (toolCalls?.length ?? 0) - 1; index >= 0; index -= 1) {
    const call = toolCalls?.[index];
    if (call?.toolName !== "request_clarification") continue;
    const parsed = ClarificationRequestSchema.safeParse(call.input);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

export interface ClarificationAnswer {
  questionId: string;
  prompt: string;
  answer: string;
  source: "user" | "agent";
}

export interface ClarificationFlow {
  token: string;
  taskId: string;
  /** 这张卡挂在哪个话题下。用户在话题里补一句话时，靠它找回这张卡。 */
  topicId: string;
  botId: string;
  sessionId: string;
  ownerOpenId: string;
  ownerUnionId?: string;
  originalMessageId: string;
  cardMessageId?: string;
  replyInThread: boolean;
  request: ClarificationRequest;
  currentIndex: number;
  answers: ClarificationAnswer[];
}

export type CreateClarificationFlowOptions = Omit<
  ClarificationFlow,
  "token" | "currentIndex" | "answers"
>;

export function isClarificationOwner(
  flow: Pick<ClarificationFlow, "ownerOpenId" | "ownerUnionId">,
  operator: { operatorOpenId: string; operatorUnionId?: string },
): boolean {
  if (flow.ownerUnionId && operator.operatorUnionId) {
    return flow.ownerUnionId === operator.operatorUnionId;
  }
  return flow.ownerOpenId === operator.operatorOpenId;
}

export function formatClarificationAnswers(flow: ClarificationFlow): string {
  const lines = flow.answers.map((answer, index) =>
    [
      `${index + 1}. ${answer.prompt}`,
      answer.source === "agent"
        ? `Agent 采用推荐方案：${answer.answer}`
        : `用户回答：${answer.answer}`,
    ].join("\n"),
  );
  return [
    "用户已经通过飞书卡片回答了上一轮需求澄清问题。",
    ...lines,
    "请基于这些答案继续工作。如果仍有会实质影响方案的未决问题，再次调用 request_clarification；否则直接整理清晰、可验收的产品结论。",
  ].join("\n\n");
}

/** 用户没点卡片、直接在话题里补一句时，把已确认答案和新消息一起带回原会话。 */
export function formatClarificationMessage(
  flow: ClarificationFlow,
  message: string,
): string {
  const confirmed = flow.answers.length
    ? formatClarificationAnswers(flow)
    : "此前还没有确认任何选项。";
  const currentQuestion = flow.request.questions[flow.currentIndex];
  return [
    "用户没有继续点击上一张需求澄清卡片，而是在同一个飞书话题里补充了新的信息。旧卡片已经失效，这条消息仍属于同一个任务。",
    confirmed,
    currentQuestion ? `上一张卡片正在询问：${currentQuestion.prompt}` : "",
    `用户的新消息：${message}`,
    "请优先理解这条新消息对既有需求的修正。如果仍有关键歧义，重新调用 request_clarification；信息已经足够时，直接整理可验收的需求结论。",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export class ClarificationFlowStore {
  private readonly flows = new Map<string, ClarificationFlow>();

  create(options: CreateClarificationFlowOptions): ClarificationFlow {
    // 同一任务只保留一个当前流程，旧卡片自然失效。
    for (const [token, flow] of this.flows) {
      // 按话题去重：同一话题里弹出新卡，用户眼前那张旧卡就该失效。
      // 按任务比的话，同话题里两件事各留一张卡，用户不知道该点哪张。
      if (flow.topicId === options.topicId && flow.botId === options.botId) {
        this.flows.delete(token);
      }
    }
    const flow: ClarificationFlow = {
      token: randomUUID().replaceAll("-", ""),
      ...options,
      currentIndex: 0,
      answers: [],
    };
    this.flows.set(flow.token, flow);
    return flow;
  }

  get(token: string): ClarificationFlow | undefined {
    return this.flows.get(token);
  }

  /**
   * 这个话题里、这台 bot 有没有还没答完的澄清卡。
   * 按话题找而不是按任务找：用户补的那句话属于一件**新**发起的事，
   * 但它要接上的是之前那张卡。
   */
  findForTopic(topicId: string, botId: string): ClarificationFlow | undefined {
    for (const flow of this.flows.values()) {
      if (flow.topicId === topicId && flow.botId === botId) return flow;
    }
    return undefined;
  }

  delete(token: string): void {
    this.flows.delete(token);
  }

  answer(
    token: string,
    questionId: string,
    answer: string,
    source: ClarificationAnswer["source"] = "user",
  ): { flow: ClarificationFlow; complete: boolean } | undefined {
    const flow = this.flows.get(token);
    const question = flow?.request.questions[flow.currentIndex];
    const normalized = answer.trim();
    if (!flow || !question || question.id !== questionId || !normalized) {
      return undefined;
    }
    flow.answers.push({
      questionId: question.id,
      prompt: question.prompt,
      answer: normalized,
      source,
    });
    flow.currentIndex += 1;
    return {
      flow,
      complete: flow.currentIndex >= flow.request.questions.length,
    };
  }

  /** 当前题或全部剩余题直接采用推荐项。 */
  answerWithRecommendation(
    token: string,
    allRemaining: boolean,
  ): { flow: ClarificationFlow; complete: boolean } | undefined {
    const flow = this.flows.get(token);
    if (!flow) return undefined;

    let result: { flow: ClarificationFlow; complete: boolean } | undefined;
    while (flow.currentIndex < flow.request.questions.length) {
      const question = flow.request.questions[flow.currentIndex];
      if (!question) break;
      const recommended =
        question.options.find(
          (option) => option.id === question.recommendedOptionId,
        ) ?? question.options[0];
      if (!recommended) return result;
      result = this.answer(token, question.id, recommended.label, "agent");
      if (!result || result.complete || !allRemaining) return result;
    }
    return (
      result ?? {
        flow,
        complete: flow.currentIndex >= flow.request.questions.length,
      }
    );
  }
}
