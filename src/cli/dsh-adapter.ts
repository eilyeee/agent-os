/** DeepSeek Harness 适配器：headless JSONL、原生会话续接与应用工具翻译。 */
import { z } from "zod";
import { createHash } from "node:crypto";
import { DSH_APP_TOOL_NAMES, dshAppToolArgs } from "./app-tools.js";
import type { CliAdapter, CliCompactPlan, CliEvent, CliPromptInput } from "./types.js";

const Count = z.number().int().nonnegative();
const MAX_TOOL_IDENTIFIER_LENGTH = 256; // 字符：至多 1 KiB，保证标识低于上游 8 KiB 截断线。
const TOOL_DETAIL_MAX_CHARS = 160; // 字符：卡片保持可扫描，重复检测另外使用完整参数指纹。
const UsageSchema = z.object({
  inputTokens: Count.optional(), outputTokens: Count.optional(), totalTokens: Count.optional(),
  cacheReadTokens: Count.optional(), cacheWriteTokens: Count.optional(),
});
const ReasonSchema = z.object({
  kind: z.string(), message: z.string().optional(),
  error: z.object({ message: z.string().optional() }).optional(),
});
const DshEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session"), sessionId: z.string().min(1), truncated: z.boolean().optional() }),
  z.object({ type: z.literal("status"), phase: z.string(), usage: UsageSchema.optional().catch(undefined), reason: ReasonSchema.nullish(), truncated: z.boolean().optional() }),
  z.object({ type: z.literal("tool_call"), callId: z.string().min(1).max(MAX_TOOL_IDENTIFIER_LENGTH), tool: z.string().min(1).max(MAX_TOOL_IDENTIFIER_LENGTH), input: z.unknown(), truncated: z.boolean().optional() }),
  z.object({ type: z.literal("tool_result"), callId: z.string().min(1).max(MAX_TOOL_IDENTIFIER_LENGTH), status: z.enum(["completed", "error"]), truncated: z.boolean().optional() }),
  z.object({ type: z.literal("final"), text: z.string(), reason: ReasonSchema.nullish(), sessionId: z.string().min(1).optional(), truncated: z.boolean().optional() }),
  z.object({ type: z.literal("error"), message: z.string(), truncated: z.boolean().optional() }),
]);
const TruncatedCriticalEventSchema = z.object({
  type: z.enum(["session", "final"]), truncated: z.literal(true),
});
const BridgeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }),
  z.object({ kind: z.literal("session"), sessionId: z.string().min(1).max(256) }),
  z.object({ kind: z.literal("error"), message: z.string() }),
  z.object({ kind: z.literal("subagent"), rootSessionId: z.string().min(1), sessionId: z.string().min(1), role: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("usage"), rootSessionId: z.string().min(1), sessionId: z.string().min(1), usage: UsageSchema.optional().catch(undefined) }),
  z.object({ kind: z.literal("app_tool"), rootSessionId: z.string().min(1), sessionId: z.string().min(1), callId: z.string().min(1), executionId: z.string().min(1), tool: z.string(), input: z.unknown(), failed: z.boolean() }),
]);
const BridgeEnvelope = z.object({ type: z.literal("agent_os.bridge"), version: z.literal(1) });
const BridgeType = z.object({ type: z.literal("agent_os.bridge") });
const NativeAppCall = z.object({ type: z.literal("tool_call"), tool: z.enum(Object.keys(DSH_APP_TOOL_NAMES) as [string, ...string[]]) });
const DetailSchema = z.object({
  file_path: z.string().optional(), path: z.string().optional(), pattern: z.string().optional(),
  query: z.string().optional(), description: z.string().optional(),
});
const TOOL_LABELS: Record<string, string> = {
  bash: "运行命令", read: "读取文件", write: "写入文件", edit: "修改文件",
  glob: "查找文件", grep: "搜索代码", subagent: "启动子任务", subagent_fork: "启动子任务",
  web_fetch: "读取网页", web_search: "搜索资料",
  request_clarification: "澄清需求", request_spec_approval: "确认产品方案",
  request_approval: "申请审批", dispatch_task: "派发任务", schedule_manage: "管理定时任务",
};

export class DshAdapter implements CliAdapter {
  readonly id = "dsh" as const;
  readonly command = "dsh";
  readonly displayName = "DeepSeek Harness";
  // 已发布 headless 没有历史列表与命令路由；普通任务中的 /compact 不是原生命令。
  readonly capabilities = { subagents: true, nativeHistory: false, nativeCompact: false, appToolsReady: true, singleAppTool: true } as const;

  buildArgs(prompt: string, promptInput: CliPromptInput): string[] {
    return ["--profile", "headless", ...dshAppToolArgs(), "--json", "--", promptInput === "stdin" ? "-" : prompt];
  }

  buildResumeArgs(prompt: string, sessionId: string, promptInput: CliPromptInput): string[] {
    return ["--profile", "headless", ...dshAppToolArgs(), "--json", "--session-id", sessionId, "--", promptInput === "stdin" ? "-" : prompt];
  }

  buildCompactPlan(): CliCompactPlan {
    return { protocol: "unsupported", message: "DeepSeek Harness 的 headless 模式暂不支持手动 /compact。可继续当前话题使用原生自动压缩，或用 /new 开启新会话。" };
  }

  parseEvents(line: string): CliEvent[] {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { return []; }
    if (BridgeType.safeParse(raw).success) {
      const envelope = BridgeEnvelope.safeParse(raw);
      const bridge = BridgeSchema.safeParse(raw);
      if (!envelope.success || !bridge.success) return [{ type: "error", message: "DeepSeek Harness 的工具桥接协议不兼容，请检查 DSH 与 Agent OS 版本后重试。" }];
      const event = bridge.data;
      if (event.kind === "ready") return [{ type: "ready" }];
      if (event.kind === "session") return [{ type: "session", sessionId: event.sessionId }];
      if (event.kind === "error") return [{ type: "error", message: event.message }];
      if (event.kind === "subagent") return [{ type: "subagent", subagentType: event.role }];
      if (event.kind === "usage") return [usageEvent(event.usage)];
      const toolName = Object.hasOwn(DSH_APP_TOOL_NAMES, event.tool) ? DSH_APP_TOOL_NAMES[event.tool] : undefined;
      if (!toolName) return [];
      // 模型 callId 可跨步骤复用；会话作用域和原生 token 分配的执行标识缺一不可。
      const toolUseId = `bridge:${JSON.stringify([event.sessionId, event.callId, event.executionId])}`;
      return [
        { type: "tool_start", toolUseId, toolName: event.tool, label: TOOL_LABELS[toolName]! },
        { type: "tool_end", toolUseId, failed: event.failed },
        ...(event.failed ? [] : [{ type: "tool_call" as const, toolUseId, toolName, input: event.input, completed: true }]),
      ];
    }
    // 应用工具只消费桥接的无损最终结果，不使用原生 JSONL 截断后的入参或提前调用通知。
    if (NativeAppCall.safeParse(raw).success) return [];
    // 普通工具日志只是进度投影，截断不代表执行失败；只有会话绑定与最终答案必须无损。
    if (TruncatedCriticalEventSchema.safeParse(raw).success) {
      return [{ type: "error", message: "DeepSeek Harness 返回了被截断的事件，已停止处理。请缩短工具参数后重试。" }];
    }
    const parsed = DshEventSchema.safeParse(raw);
    if (!parsed.success) return [];
    const event = parsed.data;
    switch (event.type) {
      case "session": return [{ type: "session", sessionId: event.sessionId }];
      case "status": {
        // 0.2.1-rc.5 的结束原因在 turn_end；新版也可能在 final 携带，两个入口都校验。
        if (event.phase === "turn_end" && event.reason?.kind !== "completed") {
          return [{ type: "error", message: event.reason?.error?.message ?? event.reason?.message ?? "DeepSeek Harness 任务未完成，请查看引擎日志后重试。" }];
        }
        if (event.phase === "turn_end" && event.reason?.kind === "completed") return [{ type: "usage", stats: { turns: 1 } }];
        if (event.phase !== "step_end") return [];
        // 缺失也是信息：某一步没报告的计数不能与其他步骤相加后冒充整轮总量。
        return [usageEvent(event.usage)];
      }
      case "tool_call": {
        const detail = DetailSchema.safeParse(event.input);
        const text = detail.success ? detail.data.file_path ?? detail.data.path ?? detail.data.pattern ?? detail.data.query ?? detail.data.description : undefined;
        const events: CliEvent[] = [{
          type: "tool_start", toolUseId: `native:${event.callId}`, toolName: event.tool,
          label: Object.hasOwn(TOOL_LABELS, event.tool) ? TOOL_LABELS[event.tool]! : `调用 ${event.tool}`,
          ...(text ? { detail: text.replace(/\s+/g, " ").slice(0, TOOL_DETAIL_MAX_CHARS) } : {}),
          // 截断后两个不同的大参数可能相同，不能拿它们触发完整参数的重复检测。
          ...(event.truncated ? {} : { inputHash: createHash("sha256").update(JSON.stringify(event.input) ?? "").digest("hex") }),
        }];
        return events;
      }
      // 调用标识受 256 字符限制，不会被截断；即使正文截断，失败状态也须消费，防止误派活。
      case "tool_result": return [{ type: "tool_end", toolUseId: `native:${event.callId}`, failed: event.status === "error" }];
      case "final":
        if (Object.hasOwn(event, "reason") && event.reason?.kind !== "completed") return [{ type: "error", message: event.reason?.error?.message ?? event.reason?.message ?? "DeepSeek Harness 任务未完成，请重试。" }];
        // text 事件只是中途回答，只有无损的 final 才能结算；工具调用轮允许空答案。
        return [{ type: "result", answer: event.text, final: true, ...(event.sessionId ? { sessionId: event.sessionId } : {}) }];
      case "error": return [{ type: "error", message: event.message }];
    }
  }
}

/** 根会话的 step_end 与子任务的原生结算共用计数语义，缺项绝不补零。 */
function usageEvent(usage: z.infer<typeof UsageSchema> | undefined): CliEvent {
  return { type: "usage", stats: {
    inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens,
    totalTokens: usage?.totalTokens, cacheReadTokens: usage?.cacheReadTokens,
    cacheCreationTokens: usage?.cacheWriteTokens,
  } };
}
