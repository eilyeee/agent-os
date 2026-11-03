/** 调用执行引擎的唯一入口。上层只说明用哪个引擎、在哪个目录、是否续接。 */
import { runCli } from "../cli/runner.js";
import type { CliAdapter, CliEvent, CliRunResult } from "../cli/types.js";

export function executeCli(
  adapter: CliAdapter,
  prompt: string,
  workspaceDir: string,
  sessionId: string | undefined,
  signal: AbortSignal,
  onEvent?: (event: CliEvent) => void,
  limits?: { idleTimeoutMinutes: number; maxRuntimeMinutes: number },
  onRetry?: (attempt: number, error: Error) => void,
): Promise<CliRunResult> {
  return runCli({
    adapter,
    prompt,
    cwd: workspaceDir,
    ...(sessionId ? { sessionId } : {}),
    signal,
    ...(onEvent ? { onEvent } : {}),
    ...(limits
      ? {
          idleTimeoutMs: limits.idleTimeoutMinutes * 60_000,
          maxRuntimeMs: limits.maxRuntimeMinutes * 60_000,
        }
      : {}),
    ...(onRetry ? { onRetry } : {}),
  });
}
