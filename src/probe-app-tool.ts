/**
 * 应用工具探针：不经过飞书，单独验证 MCP 工具链。
 * 用法：pnpm probe:tool <claude|codex> [工作目录]
 */
import { resolve } from "node:path";
import { getCliAdapter, parseCliId } from "./cli/registry.js";
import { runCli } from "./cli/runner.js";
import { findClarificationRequest } from "./core/clarification.js";

const cliId = parseCliId(process.argv[2]);
const workspace = resolve(process.argv[3] ?? process.cwd());
const adapter = getCliAdapter(cliId);

console.log(`[探针] ${adapter.displayName} @ ${workspace}`);

const result = await runCli({
  adapter,
  cwd: workspace,
  prompt: [
    "我们准备给任务列表增加优先级功能。",
    "请调用 request_clarification，询问一个会实质影响实现范围的问题。",
    "提供 2 到 4 个清晰选项，并标记推荐项。",
    "调用工具后，用一句话结束。",
  ].join("\n"),
  onEvent(event) {
    if (event.type !== "tool_call") return;
    console.log(`\n[应用工具] ${event.toolName}`);
    console.log(JSON.stringify(event.input, null, 2));
  },
});

const unexpected = result.toolCalls?.find(
  (call) => call.toolName !== "request_clarification",
);
if (unexpected) {
  throw new Error(`应用层收到未统一的工具名：${unexpected.toolName}`);
}

const clarification = findClarificationRequest(result.toolCalls);
if (!clarification) {
  throw new Error(
    `${adapter.displayName} 没有返回通过 Zod 校验的 request_clarification`,
  );
}

console.log(
  `\n[完成] ${adapter.displayName} 返回 ${clarification.questions.length} 个合法问题`,
);
