/** 自建 MCP Server 的工具名，以及把它挂到各 CLI 上的启动参数。 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dshRuntimeBridgeSource } from "./dsh-runtime-bridge.js";

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

/** DSH 与 Claude 使用相同的 MCP 命名空间。 */
export const DSH_APP_TOOL_NAMES = CLAUDE_APP_TOOL_NAMES;

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

/** 临时目录会被系统清理；每次确认文件仍完整，原子替换避免并发 CLI 读到半份配置。 */
function temporaryConfigFile(prefix: string, content: string, extension: string): string {
  const directory = join(tmpdir(), "agent-os-mcp");
  mkdirSync(directory, { recursive: true });
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  const path = join(directory, `${prefix}${hash}.${extension}`);
  try {
    if (readFileSync(path, "utf8") === content) return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally {
    // 写入或替换失败也不能留下半成品，更不能把一个未成功写出的路径当作缓存。
    rmSync(temporaryPath, { force: true });
  }
  return path;
}

/**
 * --mcp-config 同时接受 JSON 文件路径和 JSON 字符串，这里用文件。
 * 把一大段带引号的 JSON 放进 argv，在 Windows 的 cmd 下会被拆碎，工具就挂不上了。
 */
function mcpConfigFile(): string {
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
  return temporaryConfigFile("", content, "json");
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

export function dshAppToolArgs(): string[] {
  const invocation = serverInvocation();
  const bridge = dshRuntimeBridgeSource(Object.keys(DSH_APP_TOOL_NAMES));
  const bridgePath = temporaryConfigFile("dsh-bridge-", bridge, "mjs");
  // JSON 是 YAML 子集；用文件传 patch，Windows 的 cmd 才不会拆碎引号和路径。
  const content = JSON.stringify([
    { id: "sandbox-policy", config: { mode: "workspace-write" } },
    // headless 没有交互审批通道。never 拒绝需提权的动作，不能把它理解成自动批准。
    { id: "approval", config: { policy: "never" } },
    { id: "agent-loop", config: { agents: [] } },
    // 原生必需入口依赖就绪服务：MCP 或桥接加载失败时，在模型执行前终止启动。
    { id: "headless-runner", inject: ["headlessStartup", "agentOsBridge"] },
    // 原生权限服务要求沙箱与审批默认值对应到同一个 preset，否则插件不会激活。
    { id: "permission", config: {
      defaultPreset: "agent-os",
      presets: { "agent-os": { sandbox: "workspace-write", approval: "never" } },
    } },
    { insert: [{ id: "agent-os-bridge", name: bridgePath }, {
      id: "agent-os-mcp",
      name: "@deepseek-ai/dsh-mcp-client",
      config: {
        serverName: "agent_os", transport: "stdio",
        command: invocation.command, args: invocation.args,
        failOnStartupError: true,
      },
    }] },
  ]);
  return ["--patch", temporaryConfigFile("dsh-", content, "json")];
}
