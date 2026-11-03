/** Codex 适配器：exec / exec resume 参数组装 + JSONL 事件翻译。 */
import type {
  CliAdapter,
  CliCompactPlan,
  CliEvent,
  CliPromptInput,
  CliRunStats,
} from "./types.js";
import { APP_TOOL_NAMES, codexAppToolArgs } from "./app-tools.js";

interface CodexEvent {
  type?: unknown;
  thread_id?: unknown;
  item?: unknown;
  usage?: unknown;
  error?: unknown;
  message?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function shortText(value: unknown, maxLength = 72): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function firstChangedPath(item: Record<string, unknown>): string | undefined {
  if (typeof item.path === "string") return shortText(item.path);
  if (!Array.isArray(item.changes)) return undefined;
  const change = item.changes.find(isRecord);
  return change ? shortText(change.path) : undefined;
}

function toolInfo(
  item: Record<string, unknown>,
): { toolName: string; label: string; detail?: string } | undefined {
  if (item.type === "command_execution") {
    const detail = shortText(item.command);
    return { toolName: "Bash", label: "运行命令", ...(detail ? { detail } : {}) };
  }
  if (item.type === "file_change") {
    const detail = firstChangedPath(item);
    return { toolName: "Edit", label: "修改文件", ...(detail ? { detail } : {}) };
  }
  if (item.type === "web_search") {
    const detail = shortText(item.query);
    return { toolName: "WebSearch", label: "搜索资料", ...(detail ? { detail } : {}) };
  }
  if (item.type === "mcp_tool_call") {
    const server = typeof item.server === "string" ? item.server : "";
    const tool = typeof item.tool === "string" ? item.tool : "";
    const detail = shortText([server, tool].filter(Boolean).join("."));
    return {
      toolName: "MCP",
      label: "调用外部工具",
      ...(detail ? { detail } : {}),
    };
  }
  return undefined;
}

function parseStats(usage: unknown): CliRunStats | undefined {
  if (!isRecord(usage)) return undefined;
  const inputTokens = asNumber(usage.input_tokens);
  const outputTokens = asNumber(usage.output_tokens);
  const cacheReadTokens = asNumber(usage.cached_input_tokens);
  const totalTokens =
    inputTokens === undefined && outputTokens === undefined
      ? undefined
      : (inputTokens ?? 0) + (outputTokens ?? 0);
  const stats: CliRunStats = {
    totalTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
  };
  return Object.values(stats).some((value) => value !== undefined)
    ? stats
    : undefined;
}

function errorMessage(event: CodexEvent): string {
  if (typeof event.message === "string") return event.message;
  if (isRecord(event.error) && typeof event.error.message === "string") {
    return event.error.message;
  }
  return "Codex 执行失败";
}

/**
 * Windows 上 Codex 的沙箱功能不受支持，必须完全禁用，否则起不来；
 * macOS/Linux 用 --yolo 跳过审批，避免无头环境卡在审批提示上。
 * 两者都只能用于受信任、可回退的工作目录。
 */
function sandboxFlag(): string {
  return process.platform === "win32"
    ? "--dangerously-bypass-approvals-and-sandbox"
    : "--yolo";
}

/** Windows 下 prompt 走 stdin，Codex 用末尾的 `-` 表示从 stdin 读取。 */
function promptArg(prompt: string, promptInput: CliPromptInput): string {
  return promptInput === "stdin" ? "-" : prompt;
}

export class CodexAdapter implements CliAdapter {
  readonly id = "codex" as const;
  readonly command = "codex";
  readonly displayName = "Codex";
  /** 没有子 Agent 概念。 */
  readonly capabilities = { subagents: false } as const;

  buildArgs(prompt: string, promptInput: CliPromptInput): string[] {
    // -c 配置项必须出现在子命令之前。
    return [
      ...codexAppToolArgs(),
      "exec",
      "--json",
      "--skip-git-repo-check",
      sandboxFlag(),
      promptArg(prompt, promptInput),
    ];
  }

  buildResumeArgs(
    prompt: string,
    sessionId: string,
    promptInput: CliPromptInput,
  ): string[] {
    return [
      ...codexAppToolArgs(),
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      sandboxFlag(),
      sessionId,
      promptArg(prompt, promptInput),
    ];
  }

  buildCompactPlan(sessionId: string, instructions?: string): CliCompactPlan {
    // Codex 的原生压缩通过 app-server 的 thread/compact/start 触发，不接受附加要求。
    // 静默忽略会让用户以为「保留接口约定」生效了，所以要显式提示。
    if (instructions?.trim()) {
      console.warn("[Codex] 原生压缩不支持附加要求，本次按默认策略整理");
    }
    return {
      protocol: "codex-app-server",
      command: this.command,
      args: ["app-server", "--stdio"],
      sessionId,
    };
  }

  parseEvents(line: string): CliEvent[] {
    let event: CodexEvent;
    try {
      event = JSON.parse(line) as CodexEvent;
    } catch {
      // Codex 网络重连时会打非 JSON 日志，跳过即可。
      return [];
    }

    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      return [{ type: "session", sessionId: event.thread_id }];
    }
    if (event.type === "error" || event.type === "turn.failed") {
      return [{ type: "error", message: errorMessage(event) }];
    }
    if (event.type === "turn.completed") {
      const stats = parseStats(event.usage);
      // 答案和用量分在两个事件里，这里只带回用量，由 Runner 合并。
      return stats ? [{ type: "result", answer: "", stats }] : [];
    }

    if (!isRecord(event.item)) return [];
    const item = event.item;

    if (
      event.type === "item.completed" &&
      item.type === "agent_message" &&
      typeof item.text === "string"
    ) {
      return [{ type: "result", answer: item.text }];
    }

    if (typeof item.id !== "string") return [];
    const tool = toolInfo(item);
    if (!tool) return [];

    const appToolCall: CliEvent[] =
      item.type === "mcp_tool_call" &&
      item.server === "agent_os" &&
      typeof item.tool === "string" &&
      APP_TOOL_NAMES.has(item.tool)
        ? [
            {
              type: "tool_call",
              toolUseId: item.id,
              toolName: item.tool,
              input: item.arguments ?? item.input,
            },
          ]
        : [];

    if (event.type === "item.started") {
      return [{ type: "tool_start", toolUseId: item.id, ...tool }, ...appToolCall];
    }

    if (event.type === "item.completed") {
      const exitCode = asNumber(item.exit_code);
      const failed =
        item.status === "failed" || (exitCode !== undefined && exitCode !== 0);
      // tool_call 先于 tool_end：失败的调用会被 Runner 从结果中移除。
      return [
        ...appToolCall,
        { type: "tool_end", toolUseId: item.id, failed },
      ];
    }

    return [];
  }
}
