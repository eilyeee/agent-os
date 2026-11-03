/** Claude Code 适配器：headless 参数组装 + stream-json 事件翻译。 */
import type {
  CliAdapter,
  CliCompactPlan,
  CliEvent,
  CliPromptInput,
  CliRunStats,
} from "./types.js";
import { CLAUDE_APP_TOOL_NAMES, claudeAppToolArgs } from "./app-tools.js";

interface ClaudeEvent {
  type?: unknown;
  subtype?: unknown;
  is_error?: unknown;
  result?: unknown;
  session_id?: unknown;
  duration_ms?: unknown;
  num_turns?: unknown;
  usage?: unknown;
  modelUsage?: unknown;
  message?: unknown;
}

interface ClaudeContentBlock {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  is_error?: unknown;
}

const TOOL_LABELS: Record<string, string> = {
  Agent: "启动子任务",
  Bash: "运行命令",
  Edit: "修改文件",
  Glob: "查找文件",
  Grep: "搜索代码",
  Read: "读取文件",
  Task: "启动子任务",
  TaskOutput: "等待子任务完成",
  WebFetch: "读取网页",
  WebSearch: "搜索资料",
  Write: "写入文件",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function shortPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const normalized = value.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.slice(normalized.startsWith("/") ? -2 : -3).join("/");
}

function shortText(value: unknown, maxLength = 72): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function toolDetail(name: string, input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  if (["Read", "Edit", "Write"].includes(name)) return shortPath(input.file_path);
  if (name === "Glob" || name === "Grep") return shortText(input.pattern);
  if (name === "Bash") return shortText(input.description);
  if (name === "Agent" || name === "Task") return shortText(input.description);
  if (name === "WebSearch") return shortText(input.query);
  return undefined;
}

function messageBlocks(message: unknown): ClaudeContentBlock[] {
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord);
}

function usageTokens(usage: unknown): number | undefined {
  if (!isRecord(usage)) return undefined;
  const values = [
    asNumber(usage.input_tokens),
    asNumber(usage.output_tokens),
    asNumber(usage.cache_read_input_tokens),
    asNumber(usage.cache_creation_input_tokens),
  ].filter((value): value is number => value !== undefined);
  return values.length
    ? values.reduce((sum, value) => sum + value, 0)
    : undefined;
}

function contextWindowTokens(modelUsage: unknown): number | undefined {
  if (!isRecord(modelUsage)) return undefined;
  const windows = Object.values(modelUsage)
    .filter(isRecord)
    .map((usage) => asNumber(usage.contextWindow))
    .filter((value): value is number => value !== undefined && value > 0);
  return windows.length ? Math.max(...windows) : undefined;
}

function parseStats(event: ClaudeEvent): CliRunStats | undefined {
  const usage = isRecord(event.usage) ? event.usage : {};
  const stats: CliRunStats = {
    durationMs: asNumber(event.duration_ms),
    turns: asNumber(event.num_turns),
    // result.usage 是整次执行的累计消耗，不能当作当前上下文，
    // 否则长任务会显示「上下文 260.6k / 200k」这种自相矛盾的结果。
    totalTokens: usageTokens(usage),
    inputTokens: asNumber(usage.input_tokens),
    outputTokens: asNumber(usage.output_tokens),
    cacheReadTokens: asNumber(usage.cache_read_input_tokens),
    cacheCreationTokens: asNumber(usage.cache_creation_input_tokens),
    contextWindowTokens: contextWindowTokens(event.modelUsage),
  };
  return Object.values(stats).some((value) => value !== undefined)
    ? stats
    : undefined;
}

/**
 * 派生子 Agent 的那个工具，不同版本的 Claude Code 里叫法不同：
 * 新的叫 Agent，旧的叫 Task。两个都认——只盯一个名字，换个版本就全看不见了，
 * 而「看不见」和「没派过」在数据上长得一模一样。
 */
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

function subagentType(toolName: string, input: unknown): string | undefined {
  if (!SUBAGENT_TOOLS.has(toolName) || !isRecord(input)) return undefined;
  const value = input.subagent_type;
  return typeof value === "string" && value ? value : undefined;
}

function outputArgs(prompt: string, promptInput: CliPromptInput): string[] {
  return [
    // 飞书里没有权限确认界面，只能在受信任、可 git 回退的工作目录中使用。
    "--dangerously-skip-permissions",
    "-p",
    ...(promptInput === "argument" ? [prompt] : []),
    "--output-format",
    "stream-json",
    "--verbose",
    ...claudeAppToolArgs(),
  ];
}

export class ClaudeAdapter implements CliAdapter {
  readonly id = "claude" as const;
  readonly command = "claude";
  readonly displayName = "Claude Code";
  /** 有 Agent 工具，能派 .claude/agents/ 里的子 Agent。 */
  readonly capabilities = { subagents: true } as const;

  buildArgs(prompt: string, promptInput: CliPromptInput): string[] {
    return outputArgs(prompt, promptInput);
  }

  buildResumeArgs(
    prompt: string,
    sessionId: string,
    promptInput: CliPromptInput,
  ): string[] {
    return ["--resume", sessionId, ...outputArgs(prompt, promptInput)];
  }

  buildCompactPlan(sessionId: string, instructions?: string): CliCompactPlan {
    const command = instructions?.trim()
      ? `/compact ${instructions.trim()}`
      : "/compact";
    return {
      protocol: "claude-stream-json",
      command: this.command,
      // 整理指令统一走 stdin（`-p` 后不跟参数即读 stdin）。
      prompt: command,
      args: this.buildResumeArgs(command, sessionId, "stdin"),
    };
  }

  parseEvents(line: string): CliEvent[] {
    let event: ClaudeEvent;
    try {
      event = JSON.parse(line) as ClaudeEvent;
    } catch {
      // CLI 的 stdout 偶尔混进非 JSON 日志行，直接跳过。
      return [];
    }

    const sessionId =
      typeof event.session_id === "string" ? event.session_id : undefined;

    if (event.type === "system" && event.subtype === "init" && sessionId) {
      return [{ type: "session", sessionId }];
    }

    if (event.type === "assistant") {
      const message = isRecord(event.message) ? event.message : {};
      // 执行过程中的 usage 才是「当前上下文占用」。
      const usedTokens = usageTokens(message.usage);
      const events: CliEvent[] =
        usedTokens === undefined ? [] : [{ type: "context", usedTokens }];
      for (const block of messageBlocks(event.message)) {
        if (
          block.type !== "tool_use" ||
          typeof block.id !== "string" ||
          typeof block.name !== "string"
        ) {
          continue;
        }
        const detail = toolDetail(block.name, block.input);
        events.push({
          type: "tool_start",
          toolUseId: block.id,
          toolName: block.name,
          label: TOOL_LABELS[block.name] ?? `调用 ${block.name}`,
          ...(detail ? { detail } : {}),
          ...(subagentType(block.name, block.input)
            ? { subagentType: subagentType(block.name, block.input)! }
            : {}),
        });
        const appToolName = CLAUDE_APP_TOOL_NAMES[block.name];
        if (appToolName) {
          events.push({
            type: "tool_call",
            toolUseId: block.id,
            toolName: appToolName,
            input: block.input,
          });
        }
      }
      return events;
    }

    if (event.type === "user") {
      return messageBlocks(event.message).flatMap((block): CliEvent[] => {
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") {
          return [];
        }
        return [
          {
            type: "tool_end",
            toolUseId: block.tool_use_id,
            failed: block.is_error === true,
          },
        ];
      });
    }

    if (event.type !== "result") return [];

    if (event.is_error) {
      return [
        {
          type: "error",
          message:
            typeof event.result === "string"
              ? event.result
              : "Claude Code 执行失败",
          ...(sessionId ? { sessionId } : {}),
        },
      ];
    }

    if (typeof event.result !== "string") return [];
    const stats = parseStats(event);
    return [
      {
        type: "result",
        answer: event.result,
        ...(sessionId ? { sessionId } : {}),
        ...(stats ? { stats } : {}),
      },
    ];
  }
}
