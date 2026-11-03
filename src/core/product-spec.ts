/** 产品方案的参数契约与确认状态。本地 Markdown 与飞书云文档二选一，不做同步。 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolCallLike } from "./clarification.js";

/**
 * 产物必须落在工作目录内。
 * 除了 POSIX 绝对路径和 ..，还要挡住 Windows 的 C:\ 盘符路径和 \\server\share UNC 路径，
 * 否则在 Windows 上跑时，模型给出的 C:\Windows\... 会直接通过校验。
 */
const WorkspaceDocumentPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine((value) => {
    const normalized = value.replaceAll("\\", "/");
    if (normalized.startsWith("/")) return false;
    if (/^[A-Za-z]:/.test(normalized)) return false;
    return !normalized.split("/").includes("..");
  }, "文档路径必须位于当前工作目录内（不能是绝对路径或 ..）");

/**
 * 只认 https 的飞书 Docx 链接：
 * 知识库 Wiki 链接的 token 与评论事件返回的 token 不是同一个，接不上评论回流。
 * 这条正则必须和 documentToken 完全一致，否则会出现「校验通过但永远匹配不到文档」。
 */
const DOCX_PATHNAME = /^\/docx\/([A-Za-z0-9_-]+)\/?$/;

const LarkDocumentUrlSchema = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && DOCX_PATHNAME.test(url.pathname);
  } catch {
    return false;
  }
}, "documentUrl 必须是 https 的飞书 Docx 文档链接");

const ProductSpecBaseShape = {
  title: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(500),
};

export const LocalProductSpecRequestSchema = z
  .object({
    ...ProductSpecBaseShape,
    deliveryMode: z.literal("local"),
    specPath: WorkspaceDocumentPathSchema,
    ticketsPath: WorkspaceDocumentPathSchema,
  })
  .strict();

export const LarkProductSpecRequestSchema = z
  .object({
    ...ProductSpecBaseShape,
    deliveryMode: z.literal("lark-doc"),
    documentUrl: LarkDocumentUrlSchema,
  })
  .strict();

/** deliveryMode 判别联合：local 不接收 documentUrl，反过来也一样。 */
export const ProductSpecRequestSchema = z.discriminatedUnion("deliveryMode", [
  LocalProductSpecRequestSchema,
  LarkProductSpecRequestSchema,
]);

export type ProductSpecRequest = z.infer<typeof ProductSpecRequestSchema>;
export type LocalProductSpecRequest = z.infer<
  typeof LocalProductSpecRequestSchema
>;

/** MCP 只接受扁平 shape，互斥关系由上面的联合类型在 Agent OS 侧校验。 */
export const productSpecToolShape = {
  ...ProductSpecBaseShape,
  deliveryMode: z.enum(["local", "lark-doc"]),
  specPath: WorkspaceDocumentPathSchema.optional(),
  ticketsPath: WorkspaceDocumentPathSchema.optional(),
  documentUrl: LarkDocumentUrlSchema.optional(),
};

export function findProductSpecRequest(
  toolCalls: ToolCallLike[] | undefined,
): ProductSpecRequest | undefined {
  for (let index = (toolCalls?.length ?? 0) - 1; index >= 0; index -= 1) {
    const call = toolCalls?.[index];
    if (call?.toolName !== "request_spec_approval") continue;
    const parsed = ProductSpecRequestSchema.safeParse(call.input);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

export interface ProductSpecFlow {
  token: string;
  taskId: string;
  /** 这张卡挂在哪个话题下。同话题重提方案时靠它让旧卡失效。 */
  topicId: string;
  botId: string;
  /** 保存原产品会话，云文档评论要沿着它续接。 */
  sessionId: string;
  ownerOpenId: string;
  ownerUnionId?: string;
  request: ProductSpecRequest;
  status: "pending" | "approved" | "expired";
  approvedAt?: string;
}

export type CreateProductSpecFlowOptions = Omit<
  ProductSpecFlow,
  "token" | "status" | "approvedAt"
>;

export function isProductSpecOwner(
  flow: Pick<ProductSpecFlow, "ownerOpenId" | "ownerUnionId">,
  operator: { operatorOpenId: string; operatorUnionId?: string },
): boolean {
  if (flow.ownerUnionId && operator.operatorUnionId) {
    return flow.ownerUnionId === operator.operatorUnionId;
  }
  return flow.ownerOpenId === operator.operatorOpenId;
}

function documentToken(documentUrl: string): string | undefined {
  try {
    return DOCX_PATHNAME.exec(new URL(documentUrl).pathname)?.[1];
  } catch {
    return undefined;
  }
}

export class ProductSpecFlowStore {
  protected readonly flows = new Map<string, ProductSpecFlow>();

  constructor(initial: ProductSpecFlow[] = []) {
    for (const flow of initial) this.flows.set(flow.token, flow);
  }

  create(options: CreateProductSpecFlowOptions): ProductSpecFlow {
    // 同一话题里提交了新方案，旧的待确认卡立刻失效但保留记录，
    // 用户点旧卡时才能得到「已失效」而不是「找不到」。
    // 按话题而不是按任务：用户在同一个话题里改主意重提一次，那是新的一件事，
    // 但他眼前那张旧卡必须失效——按任务比的话两张卡会同时有效。
    for (const flow of this.flows.values()) {
      if (
        flow.topicId === options.topicId &&
        flow.botId === options.botId &&
        flow.status === "pending"
      ) {
        flow.status = "expired";
      }
    }
    const flow: ProductSpecFlow = {
      token: randomUUID().replaceAll("-", ""),
      ...options,
      status: "pending",
    };
    this.flows.set(flow.token, flow);
    return flow;
  }

  get(token: string): ProductSpecFlow | undefined {
    return this.flows.get(token);
  }

  findPendingByDocument(
    botId: string,
    fileToken: string,
  ): ProductSpecFlow | undefined {
    for (const flow of this.flows.values()) {
      if (
        flow.botId === botId &&
        flow.status === "pending" &&
        flow.request.deliveryMode === "lark-doc" &&
        documentToken(flow.request.documentUrl) === fileToken
      ) {
        return flow;
      }
    }
    return undefined;
  }

  /** 只接受 pending：重复点击不会改写确认时间，也不会让失效方案复活。 */
  approve(token: string): ProductSpecFlow | undefined {
    const flow = this.flows.get(token);
    if (!flow || flow.status !== "pending") return undefined;
    flow.status = "approved";
    flow.approvedAt = new Date().toISOString();
    return flow;
  }

  snapshot(): ProductSpecFlow[] {
    return [...this.flows.values()];
  }
}
