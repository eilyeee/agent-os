/**
 * 调用执行引擎的原生上下文整理能力。
 * 引擎最懂自己的消息结构，而且压缩前后 CLI 会话 ID 不变，续接无缝。
 */
import { createInterface } from "node:readline";
import type { CliAdapter, CliCompactPlan } from "./types.js";
import { killCli, spawnCli } from "./spawn-cli.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface CompactCliSessionOptions {
  adapter: CliAdapter;
  sessionId: string;
  cwd: string;
  instructions?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CompactCliSessionResult {
  sessionId: string;
  compacted: boolean;
  /**
   * 给用户看的补充说明。
   * 未整理时说明原因；整理成功时也可能有值（Codex 不支持附加要求会在这里说明），
   * 所以「有没有真的压缩过」只能看 compacted，不能拿 message 是否为空来猜。
   */
  message?: string;
}

interface JsonMessage {
  id?: unknown;
  method?: unknown;
  result?: unknown;
  error?: unknown;
  params?: unknown;
  type?: unknown;
  subtype?: unknown;
  is_error?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseJson(line: string): JsonMessage | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function protocolError(message: JsonMessage): string | undefined {
  if (!isRecord(message.error)) return undefined;
  return typeof message.error.message === "string"
    ? message.error.message
    : "原生上下文整理失败";
}

function runClaudeCompact(
  plan: Extract<CliCompactPlan, { protocol: "claude-stream-json" }>,
  options: CompactCliSessionOptions,
): Promise<CompactCliSessionResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error(`${options.adapter.displayName} 上下文整理已取消`));
      return;
    }
    const child = spawnCli(plan.command, plan.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // 未监听的 stream error 是未捕获异常，会带走整个单进程运行时。
    child.stdin.on("error", (error: Error) => fail(error));
    // `-p` 后不跟参数即读 stdin，写完必须收口，否则 Claude 会一直空等。
    child.stdin.end(`${plan.prompt}\n`, "utf8");

    const lines = createInterface({ input: child.stdout });
    let stderr = "";
    let completed = false;
    let resultMessage: string | undefined;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      lines.close();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      killCli(child);
      reject(error);
    };
    const succeed = (result: CompactCliSessionResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const abort = () =>
      fail(new Error(`${options.adapter.displayName} 上下文整理已取消`));
    const timer = setTimeout(
      () => fail(new Error(`${options.adapter.displayName} 上下文整理超时`)),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    options.signal?.addEventListener("abort", abort, { once: true });

    lines.on("line", (line: string) => {
      const message = parseJson(line);
      if (!message) return;
      // 只有收到 compact_boundary 才算真正压缩过。
      if (message.type === "system" && message.subtype === "compact_boundary") {
        completed = true;
      }
      if (message.type === "result" && message.is_error === true) {
        fail(
          new Error(
            typeof message.result === "string"
              ? message.result
              : "Claude Code 原生上下文整理失败",
          ),
        );
        return;
      }
      if (message.type === "result" && typeof message.result === "string") {
        resultMessage = message.result.trim() || undefined;
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once("error", (error: Error) => fail(error));
    child.once("close", (code: number | null) => {
      if (settled) return;
      if (code !== 0) {
        return fail(new Error(stderr.trim() || `Claude Code 退出，状态码 ${code}`));
      }
      if (!completed) {
        // 会话太短时 Claude 会跳过压缩，这是正常结果而不是失败。
        if (resultMessage === "Not enough messages to compact.") {
          return succeed({
            sessionId: options.sessionId,
            compacted: false,
            message: "当前上下文还不需要整理。继续使用一段时间后再试。",
          });
        }
        return fail(new Error("Claude Code 没有返回上下文整理完成事件"));
      }
      succeed({ sessionId: options.sessionId, compacted: true });
    });
  });
}

function runCodexCompact(
  plan: Extract<CliCompactPlan, { protocol: "codex-app-server" }>,
  options: CompactCliSessionOptions,
): Promise<CompactCliSessionResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error(`${options.adapter.displayName} 上下文整理已取消`));
      return;
    }
    const child = spawnCli(plan.command, plan.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    let stderr = "";
    let settled = false;

    // app-server 提前退出时 send() 会打到断掉的管道上，必须先接住 EPIPE。
    child.stdin.on("error", (error: Error) => fail(error));
    const send = (message: Record<string, unknown>) => {
      if (child.stdin.destroyed || !child.stdin.writable) return;
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      lines.close();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      killCli(child);
      reject(error);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      killCli(child);
      resolve({
        sessionId: options.sessionId,
        compacted: true,
        // Codex 不接受附加要求，别让用户以为自己写的偏好生效了。
        ...(options.instructions?.trim()
          ? {
              message:
                "上下文已整理。注意：Codex 的原生压缩不支持附加要求，本次按它的默认策略执行。",
            }
          : {}),
      });
    };
    const abort = () =>
      fail(new Error(`${options.adapter.displayName} 上下文整理已取消`));
    const timer = setTimeout(
      () => fail(new Error(`${options.adapter.displayName} 上下文整理超时`)),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    options.signal?.addEventListener("abort", abort, { once: true });

    lines.on("line", (line: string) => {
      const message = parseJson(line);
      if (!message) return;
      const error = protocolError(message);
      if (error) return fail(new Error(error));

      if (message.id === 1) {
        send({ method: "initialized", params: {} });
        send({ id: 2, method: "thread/resume", params: { threadId: plan.sessionId } });
        return;
      }
      if (message.id === 2) {
        send({
          id: 3,
          method: "thread/compact/start",
          params: { threadId: plan.sessionId },
        });
        return;
      }
      if (message.method !== "item/completed" || !isRecord(message.params)) return;
      const item = message.params.item;
      if (isRecord(item) && item.type === "contextCompaction") succeed();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once("error", (error: Error) => fail(error));
    child.once("close", (code: number | null) => {
      if (settled) return;
      fail(new Error(stderr.trim() || `Codex app-server 提前退出，状态码 ${code}`));
    });

    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "agent_os", title: "Agent OS", version: "0.1.0" },
      },
    });
  });
}

export function compactCliSession(
  options: CompactCliSessionOptions,
): Promise<CompactCliSessionResult> {
  const plan = options.adapter.buildCompactPlan(
    options.sessionId,
    options.instructions,
  );
  if (plan.protocol === "unsupported") return Promise.reject(new Error(plan.message));
  return plan.protocol === "claude-stream-json"
    ? runClaudeCompact(plan, options)
    : runCodexCompact(plan, options);
}
