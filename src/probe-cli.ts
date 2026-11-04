/**
 * 事件流探针：把 CLI 的 stdout 变成带时间戳的工作时间线。
 * 用法：claude -p "..." --output-format stream-json --verbose | pnpm probe:cli
 */
import { createInterface } from "node:readline";
import { listCliAdapters } from "./cli/registry.js";

const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;
const adapters = listCliAdapters();

createInterface({ input: process.stdin }).on("line", (line) => {
  // 所有引擎的解析器都试一遍，管道里是谁都能读。
  for (const adapter of adapters) {
    for (const event of adapter.parseEvents(line)) {
      switch (event.type) {
        case "session":
          console.log(`${stamp()} 会话开始 id=${event.sessionId}`);
          break;
        case "tool_start":
          console.log(
            `${stamp()} ${event.label}${event.detail ? ` · ${event.detail}` : ""}`,
          );
          break;
        case "tool_end":
          console.log(
            `${stamp()} 工具结束 ${event.toolUseId}${event.failed ? "（失败）" : ""}`,
          );
          break;
        case "context":
          console.log(`${stamp()} 当前上下文 ${event.usedTokens} tokens`);
          break;
        case "tool_call":
          console.log(`${stamp()} 应用工具 ${event.toolName}`);
          console.log(JSON.stringify(event.input, null, 2));
          break;
        case "result":
          if (event.answer) console.log(`${stamp()} 最终回答: ${event.answer}`);
          if (event.stats) {
            console.log(`${stamp()} 统计 ${JSON.stringify(event.stats)}`);
          }
          break;
        case "error":
          console.log(`${stamp()} 出错: ${event.message}`);
          break;
      }
    }
  }
});
