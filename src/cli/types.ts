/** CLI 引擎的统一契约：参数组装、事件翻译、运行结果。cli/ 以上只认这里的类型。 */

export type CliId = "claude" | "codex" | "dsh";

export type CliPromptInput = "argument" | "stdin";

/**
 * prompt 一律走 stdin，命令行里只剩无空格标志。
 * Windows 上 spawnCli 经 cmd 启动，cmd 不转义参数，中文 prompt 会被截断或乱码；
 * 其他平台也有 argv 长度上限和转义差异。走 stdin 就没有这一类问题。
 * 保留 platform 参数与 "argument" 模式，是为了让适配器两种形态都可测。
 */
export function promptInputForPlatform(
  _platform: NodeJS.Platform,
): CliPromptInput {
  return "stdin";
}

export interface CliAdapterCapabilities {
  /**
   * 这个引擎能不能派生子 Agent。Codex 不能——
   * 「有没有用子 Agent 验证过」这条判断只对能派的引擎成立，
   * 对不能派的引擎拿同一把尺子量，只会得到一片永远的「未验证」。
   */
  subagents: boolean;
  /** 没有公开原生入口时显式关闭，不能拿普通提示词冒充历史查询或压缩。 */
  nativeHistory?: boolean;
  nativeCompact?: boolean;
  /** 应用工具必须经过原生启动门并发出就绪握手，缺失时不能结算为成功。 */
  appToolsReady?: boolean;
  /** 编排每轮只接一个成功应用请求，其他调用必须明确失败，不能静默覆盖。 */
  singleAppTool?: boolean;
}

export interface CliRunStats {
  durationMs?: number;
  turns?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** 当前上下文占用，来自执行过程中的事件，不是累计消耗。 */
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  /** 这一轮派生过哪些子 Agent，按首次出现排序、去重。 */
  subagents?: string[];
  /** 上游瞬时故障重试了几次。0 次就不填。 */
  retries?: number;
  /**
   * 疑似在原地转：同一个工具调用连着重复了很多次，中间一次文件都没改。
   * 存的是那个重复的调用是什么，方便人一眼看出卡在哪儿。
   */
  spinningOn?: string;
}

export type CliEvent =
  | { type: "ready" }
  | { type: "session"; sessionId: string }
  | { type: "subagent"; subagentType: string }
  | {
      type: "tool_start";
      toolUseId: string;
      toolName: string;
      label: string;
      detail?: string;
      /** 参数指纹只用于重复检测，避免不同调用被相同的简短展示文案合并。 */
      inputHash?: string;
      /**
       * 这次调用派生了一个子 Agent 的话，是哪一个（tester / code-reviewer / …）。
       * 靠观察拿到，不靠引擎自报——自报可以撒谎，真机上就出现过报告说
       * 「等 tester 结论回来」而那一轮其实已经收尾了。
       */
      subagentType?: string;
    }
  | { type: "tool_end"; toolUseId: string; failed: boolean }
  | { type: "context"; usedTokens: number }
  /** 应用工具（我们自建的 MCP Server）调用，携带原始参数交给 app/ 处理。 */
  | { type: "tool_call"; toolUseId: string; toolName: string; input: unknown; completed?: boolean }
  /** 每步增量，由 Runner 按次运行累加。显式 undefined 表示该计数不完整，不能报总量。 */
  | { type: "usage"; stats: CliUsageStats }
  | { type: "result"; answer: string; sessionId?: string; stats?: CliRunStats; final?: boolean }
  | { type: "error"; message: string; sessionId?: string };

export type CliUsageStats = Pick<CliRunStats,
  "turns" | "totalTokens" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens"
>;

/** 原生上下文整理的执行计划。两种引擎协议不同，由 native-compact 分派。 */
export type CliCompactPlan =
  | { protocol: "unsupported"; message: string }
  | {
      protocol: "claude-stream-json";
      command: string;
      args: string[];
      prompt: string;
    }
  | {
      protocol: "codex-app-server";
      command: string;
      args: string[];
      sessionId: string;
    };

export interface CliToolCall {
  toolUseId: string;
  toolName: string;
  input: unknown;
}

export interface CliRunResult {
  answer: string;
  sessionId?: string;
  stats?: CliRunStats;
  toolCalls?: CliToolCall[];
}

export interface CliSessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  /** agent-os = Agent OS 派发的；external = 人在终端里自己开的。 */
  origin: "agent-os" | "external";
}

export interface CliAdapter {
  /** 这个引擎具备哪些能力。上层据此决定能不能对它提某些要求。 */
  readonly capabilities: CliAdapterCapabilities;
  readonly id: CliId;
  readonly command: string;
  readonly displayName: string;
  buildArgs(prompt: string, promptInput: CliPromptInput): string[];
  buildResumeArgs(
    prompt: string,
    sessionId: string,
    promptInput: CliPromptInput,
  ): string[];
  buildCompactPlan(sessionId: string, instructions?: string): CliCompactPlan;
  parseEvents(line: string): CliEvent[];
}
