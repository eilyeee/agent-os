/** 通用 CLI Runner：启动子进程、逐行分发事件、处理超时与取消。 */
import { createInterface } from "node:readline";
import type {
  CliAdapter,
  CliEvent,
  CliRunResult,
  CliRunStats,
  CliToolCall,
  CliUsageStats,
} from "./types.js";
import { promptInputForPlatform } from "./types.js";
import { killCli, spawnCli } from "./spawn-cli.js";

/**
 * 空闲超时：多久没有任何输出就判定它卡住了。
 * 量沉默而不是量总时长——固定总超时分不清「干了 25 分钟」和「卡了 25 分钟」，
 * 而按票实现一个功能本来就要几十分钟。
 * 阈值必须宽于最长的一次合法沉默：引擎跑一个十几分钟的测试套件时，
 * tool_start 之后到 tool_end 之前 stdout 是完全安静的，那不是卡死。
 */
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
/** 绝对上限：兜住真正失控的循环，空闲计时器对「一直在产出」的死循环无效。 */
const DEFAULT_MAX_RUNTIME_MS = 120 * 60 * 1000;

/** 超时错误的 name，上层据此判断，不要匹配错误文案。 */
export const CLI_TIMEOUT_ERROR = "CliTimeoutError";

/**
 * 会改动文件的工具。两种引擎的工具名不同，都列进来——
 * 漏一个的话，一轮真的改过代码的执行会被当成只读的，验证要求就绕过去了。
 * 不含 Codex 的 shell：那是通用命令执行，几乎每轮都会用，
 * 拿它当写操作等于把所有 Codex 轮次都标成改过文件。
 */
/**
 * 连着重复多少次算「疑似原地转」。
 *
 * 取 6：低于这个数正常的反复确认就会误报，而误报比漏报更坏——
 * 一个总在喊狼来了的提示，很快就没人看了。
 * 只是提示，不中止：真中止一个其实在正常干活的任务，代价比多烧几分钟大得多。
 */
const SPIN_THRESHOLD = 6;

const WRITE_TOOLS = new Set([
  "Edit",
  "Write",
  "NotebookEdit",
  "MultiEdit",
  "apply_patch",
  "edit",
  "write",
]);

/** 上游临时故障最多重试几次。 */
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 20_000;

/**
 * 上游（模型服务、网络）的临时故障，重试有意义。
 * 真机一天里撞到两次：`API Error: 500` 和 `API Error: 529 Overloaded`，
 * 各自把一次跑了半小时、已经完成四十多次工具调用的实现任务整个作废。
 * 超时和用户取消不在此列——那两种重试只会浪费更多时间。
 */
const TRANSIENT_PATTERNS = [
  /API Error: 5\d\d/i,
  /overloaded/i,
  /rate limit/i,
  /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH/,
  /socket hang up/i,
  /fetch failed/i,
  /Client network socket disconnected/i,
];

function isTransientFailure(error: Error): boolean {
  if (error.name === CLI_TIMEOUT_ERROR) return false;
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(error.message));
}

export interface RunCliOptions {
  adapter: CliAdapter;
  prompt: string;
  cwd: string;
  sessionId?: string;
  signal?: AbortSignal;
  /** 多久没有输出算卡死。 */
  idleTimeoutMs?: number;
  /** 无论是否活跃，总时长的硬上限。 */
  maxRuntimeMs?: number;
  onEvent?: (event: CliEvent) => void;
  /** 因上游临时故障重试时通知调用方，便于在卡片上说明。 */
  onRetry?: (attempt: number, error: Error) => void;
  /** 原生标识一到就落盘；失败和取消也要能继续原上下文。 */
  onSession?: (sessionId: string) => Promise<void>;
}

/**
 * 带瞬时故障重试的执行。
 * 重试时带上上一次已经拿到的 CLI 会话 id，用引擎自己的 resume 续上——
 * 否则半小时的上下文白扔，等于从头再来。
 */
export async function runCli(options: RunCliOptions): Promise<CliRunResult> {
  let sessionId = options.sessionId;
  let lastError: Error | undefined;
  const retainedToolCalls = new Map<string, CliToolCall>();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const discovered: { sessionId?: string; completedToolCalls?: CliToolCall[] } = {};
    try {
      const result = await runCliOnce(
        { ...options, ...(sessionId ? { sessionId } : {}) },
        discovered,
      );
      // 重试次数记进结果：一轮跑了 40 分钟，是一次跑完的还是断了两次接上的，
      // 事后翻历史时这是完全不同的两件事，光看耗时分不出来。
      if (attempt === 1) return result;
      // 原生执行标识在每个 CLI 进程内唯一；跨重试还要带尝试序号，不能把两次提交合并。
      const calls = [...retainedToolCalls.values(), ...(result.toolCalls ?? []).map(call => ({ ...call, toolUseId: `${attempt}:${call.toolUseId}` }))];
      if (options.adapter.capabilities?.singleAppTool && calls.length > 1) throw new Error("本轮收到多个成功的应用工具请求，已停止派发。请合并请求后重试。");
      return { ...result, ...(calls.length ? { toolCalls: calls } : {}), stats: { ...result.stats, retries: attempt - 1 } };
    } catch (error) {
      lastError = error as Error;
      // 这一次跑出来的会话 id 要留下，重试才能续上。
      if (discovered.sessionId) sessionId = discovered.sessionId;
      if (options.signal?.aborted) throw lastError;
      if (attempt >= MAX_ATTEMPTS || !isTransientFailure(lastError)) throw lastError;
      // 只跨重试保留已确认成功的请求。工具开始通知可能尚未执行，绝不能冒充成功回执。
      for (const call of discovered.completedToolCalls ?? []) retainedToolCalls.set(`${attempt}:${call.toolUseId}`, { ...call, toolUseId: `${attempt}:${call.toolUseId}` });
      console.warn(
        `[CLI] 上游临时故障，${RETRY_DELAY_MS / 1000}s 后重试（第 ${attempt + 1}/${MAX_ATTEMPTS} 次）：${lastError.message}`,
      );
      options.onRetry?.(attempt + 1, lastError);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      if (options.signal?.aborted) throw lastError;
    }
  }
  throw lastError ?? new Error(`${options.adapter.displayName} 执行失败`);
}

function runCliOnce(
  options: RunCliOptions,
  discovered: { sessionId?: string; completedToolCalls?: CliToolCall[] },
): Promise<CliRunResult> {
  const {
    adapter,
    prompt,
    cwd,
    sessionId,
    signal,
    onEvent,
  } = options;

  // setTimeout(fn, NaN) 在 Node 里会立刻触发：配置缺字段时每个任务都会瞬间「超时」，
  // 而且看起来像引擎坏了。凡是非正有限数一律退回默认值。
  const positiveOr = (value: number | undefined, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : fallback;
  const idleTimeoutMs = positiveOr(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);
  const maxRuntimeMs = positiveOr(options.maxRuntimeMs, DEFAULT_MAX_RUNTIME_MS);

  const promptInput = promptInputForPlatform(process.platform);
  const args = sessionId
    ? adapter.buildResumeArgs(prompt, sessionId, promptInput)
    : adapter.buildArgs(prompt, promptInput);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`${adapter.displayName} 执行已取消`));
      return;
    }

    // stdio 固定 pipe，保证 stdin 始终可写；abort 自己处理，
    // 不交给 spawn 的 signal 选项，否则 Windows 上只会杀掉 cmd 留下孤儿进程。
    const child = spawnCli(adapter.command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const lines = createInterface({ input: child.stdout });
    let observedSessionId = sessionId;
    let notifiedSessionId = sessionId;
    let sessionWrites = Promise.resolve();
    let appToolsReady = false;
    let observedAnswer: string | undefined;
    let observedStats: CliRunStats | undefined;
    const stepUsage: CliUsageStats = {};
    const incompleteUsage = new Set<keyof CliUsageStats>();
    // 观察到的子 Agent，按首次出现排序、去重。Set 天然保序。
    const observedSubagents = new Set<string>();
    // 改过文件没有。工具名由适配器归一化，这里只认这三个写操作。
    // 原地转的识别：同一个调用连着重复、且中间一次文件都没改。
    // 光看「重复」不行——测一遍、改一处、再测一遍是正经干活，
    // 而且今天 tester 一轮跑十遍 pnpm check 完全正常。改文件就是在推进。
    let lastSignature: string | undefined;
    let repeatCount = 0;
    let observedSpinning: string | undefined;
    const observedToolCalls = new Map<string, CliToolCall>();
    const completedToolCalls = new Set<string>();
    let resultError: Error | undefined;
    let stderr = "";
    let settled = false;
    let finishing = false;
    let timedOutReason: "idle" | "runtime" | undefined;

    // 只要还有输出就一直续期；每收到一行都重置。
    let idleTimer: NodeJS.Timeout | undefined;
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOutReason = "idle";
        killCli(child);
      }, idleTimeoutMs);
    };
    armIdleTimer();

    const runtimeTimer = setTimeout(() => {
      timedOutReason = "runtime";
      killCli(child);
    }, maxRuntimeMs);

    const abort = () => killCli(child);
    signal?.addEventListener("abort", abort, { once: true });

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(runtimeTimer);
      signal?.removeEventListener("abort", abort);
      lines.close();
    };

    // 打成具名错误：上层靠 name 判断，别去匹配文案——
    // 文案一改（比如这次拆成空闲/总时长两句），匹配就悄悄失效了。
    const timeoutError = () =>
      Object.assign(new Error(
        timedOutReason === "idle"
          ? `${adapter.displayName} 超过 ${Math.round(idleTimeoutMs / 60_000)} 分钟没有任何输出，已判定卡死并中止`
          : `${adapter.displayName} 执行超时：总时长超过 ${Math.round(maxRuntimeMs / 60_000)} 分钟`,
      ), { name: CLI_TIMEOUT_ERROR });
    // error 与 close 都可能到达，settled 保证 Promise 只结算一次。
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      discovered.completedToolCalls = [...observedToolCalls.values()].filter(call => completedToolCalls.has(call.toolUseId));
      cleanup();
      // 先等标识落盘，再释放会话占位；否则下一条消息可能抢在绑定保存前开启新上下文。
      void sessionWrites.then(() => reject(error), reject);
    };
    const succeed = (result: CliRunResult) => {
      if (settled || finishing) return;
      finishing = true;
      // CLI 退出不等于任务已结算：保存绑定期间仍可停止，不能提前移除取消监听再派活。
      void sessionWrites.then(() => {
        if (settled) return;
        if (timedOutReason) return fail(timeoutError());
        if (signal?.aborted) return fail(new Error(`${adapter.displayName} 执行已取消`));
        settled = true;
        cleanup();
        resolve(result);
      }, fail);
    };

    // 未监听的 stream error 是未捕获异常，会带走整个单进程运行时。
    child.stdin.on("error", (error: Error) => {
      if (settled) return;
      killCli(child);
      fail(
        new Error(
          stderr.trim() ||
            `${adapter.displayName} 无法接收任务内容：${error.message}`,
        ),
      );
    });
    // 挂好 error 之后再写，任务内容一律走 stdin。
    if (promptInput === "stdin") {
      child.stdin.end(prompt, "utf8");
    } else {
      // 参数模式下也要立刻收口，否则 CLI 会一直等 stdin。
      child.stdin.end();
    }

    lines.on("line", (line) => {
      if (settled) return;
      // 任何一行都算「还活着」，包括解析不了的日志噪音。
      armIdleTimer();
      for (const event of adapter.parseEvents(line)) {
        onEvent?.(event);
        if ("sessionId" in event && event.sessionId) {
          observedSessionId = event.sessionId;
          discovered.sessionId = event.sessionId;
          if (options.onSession && event.sessionId !== notifiedSessionId) {
            notifiedSessionId = event.sessionId;
            const nativeId = event.sessionId;
            sessionWrites = sessionWrites.then(() => options.onSession!(nativeId));
            void sessionWrites.catch((error: Error) => {
              killCli(child);
              fail(error);
            });
          }
        }
        if (event.type === "ready") appToolsReady = true;
        if (event.type === "subagent") observedSubagents.add(event.subagentType);
        if (event.type === "error") {
          resultError = new Error(event.message);
          continue;
        }
        if (event.type === "tool_start") {
          if (event.subagentType) observedSubagents.add(event.subagentType);
          if (WRITE_TOOLS.has(event.toolName)) {
            // 改了文件就是在推进，重复计数清零。
            // 这里只用来判断「有没有在推进」，不再用来判断「这一轮改没改过文件」——
            // 后者按工具名认会漏掉 Bash 写文件和子 Agent 写文件，改成看工作区指纹。
            lastSignature = undefined;
            repeatCount = 0;
          } else {
            const signature = `${event.toolName}:${event.inputHash ?? event.detail ?? ""}`;
            repeatCount = signature === lastSignature ? repeatCount + 1 : 1;
            lastSignature = signature;
            if (repeatCount >= SPIN_THRESHOLD && !observedSpinning) {
              observedSpinning = event.detail
                ? `${event.toolName}（${event.detail}）`
                : event.toolName;
              console.warn(
                `[CLI] 疑似原地打转：${observedSpinning} 连着重复 ${repeatCount} 次，中间没有改过文件`,
              );
            }
          }
        }
        if (event.type === "tool_call") {
          if (adapter.capabilities?.singleAppTool && observedToolCalls.size && !observedToolCalls.has(event.toolUseId)) {
            resultError = new Error("本轮收到多个成功的应用工具请求，已停止派发。请合并请求后重试。");
            continue;
          }
          observedToolCalls.set(event.toolUseId, {
            toolUseId: event.toolUseId,
            toolName: event.toolName,
            input: event.input,
          });
          if (event.completed) completedToolCalls.add(event.toolUseId);
          continue;
        }
        if (event.type === "tool_end" && event.failed) {
          observedToolCalls.delete(event.toolUseId);
          completedToolCalls.delete(event.toolUseId);
          continue;
        }
        if (event.type === "result") {
          // Codex 把答案和用量分在两个事件里，这里合并。
          if (event.answer || event.final) observedAnswer = event.answer;
          if (event.stats) observedStats = event.stats;
        }
        if (event.type === "usage") {
          // 每次执行独立累计，避免注册表中共享适配器串用两个话题的消耗。
          for (const key of Object.keys(event.stats) as (keyof CliUsageStats)[]) {
            const value = event.stats[key];
            if (value === undefined) {
              incompleteUsage.add(key);
              delete stepUsage[key];
            } else if (!incompleteUsage.has(key)) stepUsage[key] = (stepUsage[key] ?? 0) + value;
          }
          observedStats = { ...observedStats, ...stepUsage };
          for (const key of incompleteUsage) delete observedStats[key];
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.once("error", (error: Error) => {
      if (timedOutReason) return fail(timeoutError());
      if (signal?.aborted) {
        return fail(new Error(`${adapter.displayName} 执行已取消`));
      }
      fail(error);
    });

    child.once("close", (code: number | null) => {
      if (settled) return;
      if (timedOutReason) return fail(timeoutError());
      if (signal?.aborted) {
        return fail(new Error(`${adapter.displayName} 执行已取消`));
      }
      if (resultError) return fail(resultError);
      if (code !== 0) {
        return fail(
          new Error(stderr.trim() || `${adapter.displayName} 退出，状态码 ${code}`),
        );
      }
      if (adapter.capabilities?.appToolsReady && !appToolsReady) {
        return fail(new Error(`${adapter.displayName} 的应用工具未就绪，请检查 MCP 配置与 DSH 版本后重试`));
      }
      if (observedAnswer === undefined) {
        // 状态码正常却没有最终结果，说明协议没有完整走完。
        return fail(new Error(`${adapter.displayName} 没有返回最终结果`));
      }
      // 子 Agent 是我们观察出来的，引擎的 stats 里没有这一项，
      // 所以哪怕引擎一个 stats 都没给，只要派过子 Agent 就得造一个出来。
      const stats =
        observedSubagents.size || observedSpinning || observedStats
          ? {
              ...observedStats,
              ...(observedSubagents.size
                ? { subagents: [...observedSubagents] }
                : {}),
              ...(observedSpinning ? { spinningOn: observedSpinning } : {}),
            }
          : undefined;
      succeed({
        answer: observedAnswer,
        ...(observedSessionId ? { sessionId: observedSessionId } : {}),
        ...(stats ? { stats } : {}),
        ...(observedToolCalls.size
          ? { toolCalls: [...observedToolCalls.values()] }
          : {}),
      });
    });
  });
}
