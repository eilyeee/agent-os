/** 跨平台启动与终止 CLI 子进程。平台差异只在这里出现。 */
import {
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
  type SpawnOptions,
} from "node:child_process";
import type { Readable, Writable } from "node:stream";

/** SIGTERM 之后还没退出就升级到 SIGKILL 的等待时间。 */
const ESCALATE_TO_SIGKILL_MS = 5_000;

/**
 * 只属于 Agent OS 的凭证，不传给引擎子进程。
 * 引擎自己的模型凭证（ANTHROPIC_*、OPENAI_* 等）必须保留，否则它跑不起来。
 */
const OWN_SECRET_PATTERN = /^(FEISHU_|BOTS_CONFIG$|OWNER_OPEN_ID$)/;
let applicationCredentialNames = new Set<string>();

export function setApplicationCredentialNames(names: readonly string[]): void {
  applicationCredentialNames = new Set(names);
}

export function childEnvironment(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (OWN_SECRET_PATTERN.test(key) || applicationCredentialNames.has(key)) continue;
    env[key] = value;
  }
  return env;
}

/**
 * 杀掉整棵进程树。
 * Agent 常常自己再起长命令（dev server、watch），只杀直接子进程会留下孙进程；
 * 而孙进程继承着引擎的 stdout，会让 close 事件永远不触发，会话就永远卡在执行中。
 */
export function killCli(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (!child.pid) {
    child.kill(signal);
    return;
  }
  if (process.platform === "win32") {
    // Windows 上 child.pid 指向 cmd，taskkill /T 才能连同 claude.exe/codex.exe 一起杀。
    const taskkill = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    // taskkill 不在 PATH 上时会抛 ENOENT，未监听同样是未捕获异常。
    taskkill.on("error", (error) => {
      console.error("[进程] taskkill 调用失败:", error.message);
      child.kill(signal);
    });
    return;
  }

  // POSIX：detached 让子进程自成进程组，负号 pid 才能把整组一起signal。
  const killGroup = (sig: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, sig);
    } catch {
      // 进程组已经不在（正常退出），退回到只杀直接子进程。
      try {
        child.kill(sig);
      } catch {
        // 已经退出，忽略。
      }
    }
  };

  // 升级条件必须看「进程组里还有没有人」。
  // 直接子进程通常会立刻响应 SIGTERM 退出，它的 exitCode/signalCode 随即变成非空，
  // 拿它当判据的话，升级永远不会触发——而真正赖着不走的恰恰是忽略 SIGTERM 的孙进程。
  const groupAlive = (): boolean => {
    try {
      // 信号 0 只做存在性探测：组里还有任何成员就返回成功。
      process.kill(-child.pid!, 0);
      return true;
    } catch {
      return false;
    }
  };

  killGroup(signal);
  if (signal === "SIGKILL") return;
  const escalation = setTimeout(() => {
    if (groupAlive()) killGroup("SIGKILL");
  }, ESCALATE_TO_SIGKILL_MS);
  escalation.unref();
}

/**
 * Windows 上必须走 shell 才能启动 .cmd 启动器，但 Node 不会替我们转义参数。
 * 含空格或 cmd 元字符的参数要自己加引号，否则 --mcp-config 这类参数会被拆碎。
 */
function quoteForCmd(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"^&|<>()]/.test(arg)) return arg;
  // 先按 CRT 规则处理反斜杠与引号，再整体加引号。
  const escaped = arg
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, "$1$1");
  return `"${escaped}"`;
}

export function spawnCli(
  command: string,
  args: string[],
  options: SpawnOptions & { stdio: ["pipe", "pipe", "pipe"] },
): ChildProcessByStdio<Writable, Readable, Readable>;
export function spawnCli(
  command: string,
  args: string[],
  options: SpawnOptions & { stdio: SpawnOptions["stdio"] },
): ChildProcessByStdio<any, any, any>;
export function spawnCli(
  command: string,
  args: string[],
  options: SpawnOptions & { stdio: SpawnOptions["stdio"] },
): ChildProcessByStdio<any, any, any> {
  // 参数始终以数组传入，绝不拼 shell 字符串：飞书里的引号、换行、$() 只能是普通数据。
  const env = options.env ?? childEnvironment();

  if (process.platform !== "win32") {
    return spawn(command, args, {
      ...options,
      env,
      detached: true,
    }) as ChildProcessByStdio<any, any, any>;
  }

  return spawn(quoteForCmd(command), args.map(quoteForCmd), {
    ...options,
    env,
    shell: true,
    windowsHide: true,
  }) as ChildProcessByStdio<any, any, any>;
}
