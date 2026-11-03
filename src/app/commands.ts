/**
 * 命令清单的**唯一事实来源**：`/help` 从这里渲染，README 中文表逐字对照它。
 *
 * 为什么要有这份数据：两处文案分头维护时，改了行为只更新一处是常态——
 * 真机上就出现过 README 说 `/history` 能筛选能翻页、`/help` 只字未提，
 * 用户在群里看不到这个能力。现在两边同源，飘不了。
 *
 * usage 要和 README 表格第一列一字不差（含反引号里的参数写法），
 * description 同理。冒烟测试会逐行比对，改了这里就得改 README，反之亦然。
 */
export interface CommandDoc {
  /** 表格第一列：命令连同参数写法，如 `/cd [目录]`。 */
  usage: string;
  /** 表格第二列：一句话说清它做什么。 */
  description: string;
}

export const COMMAND_DOCS: readonly CommandDoc[] = [
  { usage: "/help", description: "列出可用命令" },
  { usage: "/status", description: "当前 bot、会话、执行引擎、CLI 会话 ID、工作目录" },
  {
    usage: "/history",
    description: "本群这台机器人做过的任务（跨话题），可按结局筛选、翻页查看",
  },
  {
    usage: "/cost",
    description: "本群这台机器人的开销：累计 tokens、按来源拆分、最贵的几件",
  },
  { usage: "/team", description: "团队名册：职责、引擎、Skill、连接状态" },
  { usage: "/new", description: "在本话题开启全新 CLI 会话，旧会话仍可恢复" },
  { usage: "/resume", description: "从当前工作目录里挑一个历史 CLI 会话恢复" },
  { usage: "/compact [要求]", description: "调用引擎原生能力整理当前上下文" },
  { usage: "/cd [目录]", description: "查看或切换本话题的工作目录" },
  {
    usage: "/schedule [一句话]",
    description: "查看本机器人的定时任务，或用一句话创建、调整",
  },
  { usage: "/close", description: "停止正在运行的任务并关闭本话题会话" },
  { usage: "/claude <任务>", description: "新话题使用 Claude Code" },
  { usage: "/codex <任务>", description: "新话题使用 Codex" },
];

/** `/help` 在群里回的那几行。 */
export function helpLines(): string[] {
  return COMMAND_DOCS.map((doc) => `${doc.usage} ${doc.description}`);
}
