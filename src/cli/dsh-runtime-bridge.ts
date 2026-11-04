/** 生成 DSH 原生插件：应用工具就绪门、任务树校验和无损工具结果通道。 */
export function dshRuntimeBridgeSource(toolNames: readonly string[]): string {
  // 插件由 DSH 的 Node 加载；绝对模块 URL 同时适用于 tsx 开发与构建后的安装目录。
  return `import { z } from ${JSON.stringify(import.meta.resolve("zod"))};\n`
    + `const APP_TOOLS = new Set(${JSON.stringify(toolNames)});\n`
    + BRIDGE_BODY;
}

// 运行在外部 CLI 中的插件保持自包含，不把 DSH SDK 或模型依赖带进 Agent OS。
const BRIDGE_BODY = String.raw`
export const name = "agent-os-bridge";
export const inject = ["tools", "agents"];
const Id = z.string().min(1).max(256);
const AgentShape = z.object({
  id: Id,
  session: z.object({ id: Id, header: z.object({
    origin: z.literal("subagent").optional(),
    parentSession: Id.optional(),
    delegationDepth: z.number().int().nonnegative().optional(),
    agentPreset: z.string().min(1).max(64).optional(),
  }) }),
});
// 保留原始 Agent 引用：原生 isOwnedBy 比较的是运行时对象身份。
const Agent = z.custom(value => AgentShape.safeParse(value).success);
const Created = z.object({ agent: Agent });
const Execution = z.object({ callId: Id, name: z.string(), arguments: z.unknown(), agent: Agent, token: z.symbol() });
const Outcome = z.object({ isError: z.boolean() });

export function apply(ctx) {
  let root;
  let provided = false;
  let pending;
  const executionIds = new Map();
  const owned = new Map();
  const emit = payload => process.stdout.write(JSON.stringify({ type: "agent_os.bridge", version: 1, ...payload }) + "\n");
  const belongs = agent => root && ctx.agents.get(root.id) === root && owned.get(agent.id) === agent && ctx.agents.get(agent.id) === agent;
  const available = scope => {
    const catalog = z.array(z.object({ name: z.string() })).safeParse(ctx.tools.schemas(scope));
    const names = new Set(catalog.success ? catalog.data.map(tool => tool.name) : []);
    return [...APP_TOOLS].every(tool => names.has(tool));
  };
  const ready = () => {
    if (!provided && available()) {
      provided = true;
      emit({ kind: "ready" });
      ctx.provide("agentOsBridge", { version: 1 });
    }
  };

  ctx.on("tools/change", ready);
  // 正常退出也会撤下工具，不能在卸载事件里把已完成的任务改判失败。
  ctx.on("llm/stream", (options, next) => {
    if (root && options.sessionId === root.id && !available(root)) throw new Error("DeepSeek Harness 的应用工具未就绪，请检查 MCP 后重试。");
    return next();
  });
  ctx.on("agent/created", payload => {
    const parsed = Created.safeParse(payload);
    if (!parsed.success) throw new Error("DeepSeek Harness 的 Agent 事件格式不兼容，请检查 DSH 版本。");
    const agent = parsed.data.agent;
    const header = agent.session.header;
    if (!root && !header.origin && !header.parentSession && !header.delegationDepth) {
      root = agent;
      owned.set(agent.id, agent);
      emit({ kind: "session", sessionId: agent.id });
      return;
    }
    // 只接本次 headless 主任务的后代，不能把其他运行时会话的请求送到当前飞书话题。
    if (![...owned.values()].some(owner => ctx.agents.isOwnedBy(agent.id, owner))) return;
    owned.set(agent.id, agent);
    if (header.agentPreset) emit({ kind: "subagent", rootSessionId: root.id, sessionId: agent.id, role: header.agentPreset });
  });
  ctx.on("agent/disposed", payload => {
    const parsed = Created.safeParse(payload);
    if (parsed.success && owned.get(parsed.data.agent.id) === parsed.data.agent) owned.delete(parsed.data.agent.id);
  });

  ctx.tools.guard(exec => {
    if (!APP_TOOLS.has(exec.name)) return;
    const parsed = Execution.safeParse(exec);
    if (!root || !parsed.success || !belongs(parsed.data.agent)) return "应用工具只能由本次主任务及其子任务调用，请回到原话题重试。";
    // 编排每轮只处理一个应用请求；并行子任务不能都拿到已送达回执，再悄悄丢掉前一个。
    if (pending && pending !== parsed.data.token) return "本轮已有应用请求正在处理。请把其余问题交回主任务，等待当前请求处理后再提交。";
    pending = parsed.data.token;
  });
  ctx.on("tools/result", (execution, outcome) => {
    const named = z.object({ name: z.string() }).safeParse(execution);
    if (!named.success || !APP_TOOLS.has(named.data.name)) return;
    const call = Execution.safeParse(execution);
    const result = Outcome.safeParse(outcome);
    if (!call.success || !result.success) {
      emit({ kind: "error", message: "DeepSeek Harness 的应用工具结果格式不兼容，请检查版本后重试。" });
      return;
    }
    if (!root || !belongs(call.data.agent)) return;
    if (result.data.isError && pending === call.data.token) pending = undefined;
    if (!result.data.isError && pending !== call.data.token) {
      emit({ kind: "error", message: "DeepSeek Harness 返回了未经应用请求门确认的结果，请重试。" });
      return;
    }
    // callId 由模型产生，跨步骤可能复用；原生执行 token 才唯一标识本次调用。
    if (!executionIds.has(call.data.token)) executionIds.set(call.data.token, String(executionIds.size + 1));
    // tools/result 是原生最终结果，包含子 Agent 和 PTC 内调用；不从截断后的日志猜参数。
    emit({ kind: "app_tool", rootSessionId: root.id, sessionId: call.data.agent.id,
      callId: call.data.callId, executionId: executionIds.get(call.data.token), tool: call.data.name, input: call.data.arguments, failed: result.data.isError });
  });
  ready();
}
`;
