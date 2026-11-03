/** 自建 MCP Server 的工具名，以及把它挂到两种 CLI 上的启动参数。 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const CLARIFICATION_TOOL_NAME = "request_clarification";
export const PRODUCT_SPEC_TOOL_NAME = "request_spec_approval";
export const APPROVAL_TOOL_NAME = "request_approval";
export const DISPATCH_TASK_TOOL_NAME = "dispatch_task";
export const SCHEDULE_MANAGE_TOOL_NAME = "schedule_manage";

/** Claude Code 会把 MCP 工具名展开成 mcp__<server>__<tool>，解析时要还原。 */
const CLAUDE_PREFIX = "mcp__agent_os__";
export const CLAUDE_APP_TOOL_NAMES: Record<string, string> = {
  [`${CLAUDE_PREFIX}${CLARIFICATION_TOOL_NAME}`]: CLARIFICATION_TOOL_NAME,
  [`${CLAUDE_PREFIX}${PRODUCT_SPEC_TOOL_NAME}`]: PRODUCT_SPEC_TOOL_NAME,
  [`${CLAUDE_PREFIX}${APPROVAL_TOOL_NAME}`]: APPROVAL_TOOL_NAME,
  [`${CLAUDE_PREFIX}${DISPATCH_TASK_TOOL_NAME}`]: DISPATCH_TASK_TOOL_NAME,
  [`${CLAUDE_PREFIX}${SCHEDULE_MANAGE_TOOL_NAME}`]: SCHEDULE_MANAGE_TOOL_NAME,
};

export const APP_TOOL_NAMES = new Set([
  CLARIFICATION_TOOL_NAME,
  PRODUCT_SPEC_TOOL_NAME,
  APPROVAL_TOOL_NAME,
  DISPATCH_TASK_TOOL_NAME,
  SCHEDULE_MANAGE_TOOL_NAME,
]);

/**
 * 开发时直接跑 TypeScript，Server 由项目内的 tsx 启动；
 * 构建后跑的是 JavaScript，Server 由当前 Node 进程启动。两条路径都要指对文件。
 */
function serverInvocation(): { command: string; args: string[] } {
  const runningFromTypeScript = import.meta.url.endsWith(".ts");
  const server = fileURLToPath(
    new URL(
      runningFromTypeScript
        ? "../mcp/app-tools-server.ts"
        : "../mcp/app-tools-server.js",
      import.meta.url,
    ),
  );
  if (!runningFromTypeScript) {
    return { command: process.execPath, args: [server] };
  }
  const tsxCli = fileURLToPath(
    new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url),
  );
  return { command: process.execPath, args: [tsxCli, server] };
}

let cachedConfigPath: string | undefined;

/**
 * --mcp-config 同时接受 JSON 文件路径和 JSON 字符串，这里用文件。
 * 把一大段带引号的 JSON 放进 argv，在 Windows 的 cmd 下会被拆碎，工具就挂不上了。
 */
function mcpConfigFile(): string {
  if (cachedConfigPath) return cachedConfigPath;
  const invocation = serverInvocation();
  const content = JSON.stringify({
    mcpServers: {
      agent_os: {
        type: "stdio",
        command: invocation.command,
        args: invocation.args,
      },
    },
  });
  const directory = join(tmpdir(), "agent-os-mcp");
  mkdirSync(directory, { recursive: true });
  // 文件名跟随内容哈希：换了安装路径会自动写一份新的，不会读到旧配置。
  const path = join(
    directory,
    `${createHash("sha256").update(content).digest("hex").slice(0, 16)}.json`,
  );
  writeFileSync(path, content, "utf8");
  cachedConfigPath = path;
  return path;
}

export function claudeAppToolArgs(): string[] {
  return ["--mcp-config", mcpConfigFile()];
}

export function codexAppToolArgs(): string[] {
  const invocation = serverInvocation();
  return [
    "-c",
    `mcp_servers.agent_os.command=${JSON.stringify(invocation.command)}`,
    "-c",
    `mcp_servers.agent_os.args=${JSON.stringify(invocation.args)}`,
  ];
}
