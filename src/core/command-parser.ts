/** 斜杠命令解析。整段文本必须符合「可选 @提及 + 一条命令」才会被识别。 */
import type { CliId } from "../cli/types.js";

export type SlashCommand =
  | {
      name:
        | "close"
        | "status"
        | "help"
        | "history"
        | "cost"
        | "new"
        | "resume"
        | "team";
    }
  | { name: "compact"; instructions?: string }
  | { name: "cd"; path?: string }
  | { name: "schedule"; request?: string };

/**
 * 调用方应当先用 mentions 精确剥离 @提及再传进来；这里的 `@.+?` 只是兜底，
 * 给拿不到 mentions 结构的场景用（非贪婪，机器人显示名里有空格也能识别）。
 *
 * 斜杠后面允许有空格：中文输入法会在标点后自动补空格，真机上把 `/history`
 * 打成 `/ history` 是常态，当场把命令降级成一次 CLI 任务，用户完全看不出为什么。
 */
const MENTION = String.raw`(?:@.+?\s+)?`;
const SLASH = String.raw`\/\s*`;
const COMMAND_RE = new RegExp(`^${MENTION}${SLASH}(close|status|help|history|cost|new|resume|team)\\s*$`);
const CD_RE = new RegExp(`^${MENTION}${SLASH}cd(?:\\s+([\\s\\S]+?))?\\s*$`);
const COMPACT_RE = new RegExp(`^${MENTION}${SLASH}compact(?:\\s+([\\s\\S]+?))?\\s*$`);
const SCHEDULE_RE = new RegExp(`^${MENTION}${SLASH}schedule(?:\\s+([\\s\\S]+?))?\\s*$`);
const CLI_REQUEST_RE = new RegExp(`^${MENTION}${SLASH}(claude|codex)(?:\\s+([\\s\\S]*))?$`);

export function parseCommand(text: string): SlashCommand | undefined {
  const value = text.trim();

  const cdMatch = CD_RE.exec(value);
  if (cdMatch) return { name: "cd", ...(cdMatch[1]?.trim() ? { path: cdMatch[1].trim() } : {}) };

  const compactMatch = COMPACT_RE.exec(value);
  if (compactMatch) {
    const instructions = compactMatch[1]?.trim();
    return { name: "compact", ...(instructions ? { instructions } : {}) };
  }

  const scheduleMatch = SCHEDULE_RE.exec(value);
  if (scheduleMatch) {
    const request = scheduleMatch[1]?.trim();
    return { name: "schedule", ...(request ? { request } : {}) };
  }

  const match = COMMAND_RE.exec(value);
  if (!match) return undefined;
  return {
    name: match[1] as
      | "close"
      | "status"
      | "help"
      | "history"
      | "cost"
      | "new"
      | "resume"
      | "team",
  };
}

export interface CliRequest {
  cliId: CliId;
  prompt: string;
}

export function parseCliRequest(text: string): CliRequest | undefined {
  const match = CLI_REQUEST_RE.exec(text.trim());
  if (!match) return undefined;
  return {
    cliId: match[1] as CliId,
    prompt: (match[2] ?? "").trim(),
  };
}

/** 全部命令名，用于识别「敲错的命令」。与上面几条正则同源，加命令时一起改。 */
export const KNOWN_COMMANDS = [
  "close", "status", "help", "history", "cost", "new", "resume", "team",
  "cd", "compact", "schedule", "claude", "codex",
] as const;

/**
 * 这条消息看起来是不是在敲命令：以 `/` 开头、紧跟字母。
 * 第一个 token 里还有第二个 `/` 就不算——`/Users/xxx/项目` 那是正经的任务文本，
 * 不能把人家的路径当成打错的命令挡回去。
 */
export function looksLikeCommand(text: string): string | undefined {
  const value = text.trim();
  const match = /^\/\s*([a-zA-Z][a-zA-Z0-9_-]*)/.exec(value);
  if (!match) return undefined;
  const firstToken = value.split(/\s+/)[0] ?? "";
  if (firstToken.slice(1).includes("/")) return undefined;
  return match[1].toLowerCase();
}

/** 编辑距离，只为「你是不是想输 X」这一个用途，不需要更快的实现。 */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * 最接近的已知命令。距离超过 2 就不猜——瞎猜一个八竿子打不着的命令，
 * 比直接说「没这个命令」更让人迷惑。
 */
export function closestCommand(name: string): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const known of KNOWN_COMMANDS) {
    const distance = editDistance(name, known);
    if (distance < bestDistance) {
      best = known;
      bestDistance = distance;
    }
  }
  return best;
}
