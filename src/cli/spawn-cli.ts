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
const TERMINATION_POLL_MS = 50; // 毫秒：及时释放已结束的进程组，避免等待完整的强杀宽限期。

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
): Promise<void> {
  if (!child.pid) {
    child.kill(signal);
    return Promise.resolve();
  }
  if (process.platform === "win32") {
    // Windows 的 cmd 只是启动器，必须等 taskkill /T /F 处理整棵树，不能只等 cmd 退出。
    return new Promise(resolve => {
      let fallback = false;
      const taskkill = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      // spawn 失败也会触发 close；此时要等兜底终止完成，不能被该 close 提前释放。
      taskkill.once("close", () => { if (!fallback) resolve(); });
      taskkill.once("error", error => {
        fallback = true;
        console.error("[进程] taskkill 调用失败:", error.message);
        child.kill(signal);
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once("close", () => resolve());
      });
    });
  }

  // POSIX：detached 让子进程自成进程组；stdio 被重定向的孙进程也必须在组内一并停止。
  const killGroup = (sig: NodeJS.Signals) => {
    try { process.kill(-child.pid!, sig); }
    catch {
      try { child.kill(sig); } catch { /* 进程已退出，无需再发送信号。 */ }
    }
  };
  const groupAlive = (): boolean => {
    try { process.kill(-child.pid!, 0); return true; }
    catch { return false; }
  };
  killGroup(signal);
  if (signal === "SIGKILL" || !groupAlive()) return Promise.resolve();

  return new Promise(resolve => {
    let poll: ReturnType<typeof setTimeout> | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (poll) clearTimeout(poll);
      if (escalation) clearTimeout(escalation);
      resolve();
    };
    const check = () => {
      if (!groupAlive()) { finish(); return; }
      poll = setTimeout(check, TERMINATION_POLL_MS);
    };
    // 父进程 close 后组内还可能有人；计时器要持有事件循环，不能让等待终止的 Promise 悬空退出。
    escalation = setTimeout(() => {
      if (groupAlive()) killGroup("SIGKILL");
      // SIGKILL 后僵尸进程可能暂留，但已不能执行或写文件，不能等到系统回收才释放。
      finish();
    }, ESCALATE_TO_SIGKILL_MS);
    check();
  });
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
