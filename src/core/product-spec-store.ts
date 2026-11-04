/**
 * 产品确认状态落盘。
 * 云文档评论可能在确认卡发出几分钟后才到达，重启不能让文档和原会话断联。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  ProductSpecFlowStore,
  ProductSpecRequestSchema,
  type CreateProductSpecFlowOptions,
  type ProductSpecFlow,
} from "./product-spec.js";

const ProductSpecFlowSchema = z.object({
  token: z.string().min(1),
  taskId: z.string().min(1),
  // 老记录没有这个字段，落盘时用 taskId 兜底：拆分之前 taskId 存的本来就是话题 id。
  topicId: z.string().min(1).optional(),
  botId: z.string().min(1),
  sessionId: z.string().min(1),
  ownerOpenId: z.string().min(1),
  ownerUnionId: z.string().min(1).optional(),
  request: ProductSpecRequestSchema,
  status: z.enum(["pending", "approved", "expired"]),
  approvedAt: z.iso.datetime().optional(),
});

function loadFlows(filePath: string): ProductSpecFlow[] {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let rows: unknown;
  try {
    rows = JSON.parse(content);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const parsed = ProductSpecFlowSchema.safeParse(row);
    return parsed.success ? [parsed.data as ProductSpecFlow] : [];
  });
}

export class JsonProductSpecFlowStore extends ProductSpecFlowStore {
  constructor(private readonly filePath: string) {
    super(loadFlows(filePath));
  }

  override create(options: CreateProductSpecFlowOptions): ProductSpecFlow {
    return this.mutate(() => super.create(options));
  }

  override approve(token: string): ProductSpecFlow | undefined {
    return this.mutate(() => super.approve(token));
  }

  /** 同步写盘没有 await 窗口；失败时恢复所有旧对象，连被新方案作废的旧卡也要复原。 */
  private mutate<T>(operation: () => T): T {
    const previous = [...this.flows.entries()].map(([token, flow]) => ({ token, flow, snapshot: structuredClone(flow) }));
    try {
      const result = operation();
      if (result !== undefined) this.persist();
      return result;
    } catch (error) {
      this.flows.clear();
      for (const { token, flow, snapshot } of previous) {
        for (const key of Object.keys(flow)) {
          if (!Object.hasOwn(snapshot, key)) Reflect.deleteProperty(flow, key);
        }
        Object.assign(flow, snapshot);
        this.flows.set(token, flow);
      }
      throw error;
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    // 同样走临时文件 + 原子替换。
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(this.snapshot(), null, 2)}\n`,
      "utf8",
    );
    renameSync(temporaryPath, this.filePath);
  }
}
