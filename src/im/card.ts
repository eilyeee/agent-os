/**
 * 飞书卡片构建与更新节流。
 * 卡片是一块随时可以回来查看的状态面板，不是打断人的通知推送，
 * 所以进度原地刷新，异常和待决策才由 app/ 另发消息点名。
 */
import type { CliRunStats, CliSessionSummary } from "../cli/types.js";
import type { ClarificationFlow } from "../core/clarification.js";
import type { ProductSpecFlow } from "../core/product-spec.js";
import type { ApprovalFlow } from "../core/approval.js";
import type { Schedule } from "../core/schedule.js";
import {
  TASK_ANSWER_LIMIT,
  TASK_HISTORY_FILTERS,
  type TaskHistoryFilter,
  type CostSummary,
  type TaskHistoryPage,
  type TaskRecord,
  type TaskRecordStatus,
  type TaskRunOrigin,
} from "../core/task-record.js";
import type {
  TaskActivity,
  TaskProgressSnapshot,
} from "../core/task-progress.js";

export type CardJson = Record<string, unknown>;
export type TaskStatus = "running" | "success" | "failed" | "cancelled";

export interface TaskCardOptions {
  title: string;
  status: TaskStatus;
  detail: string;
  progress?: TaskProgressSnapshot;
  answer?: string;
  stats?: CliRunStats;
  technicalDetail?: string;
  /** 有值时渲染「停止任务」按钮。 */
  abortSessionId?: string;
}

const STATUS_STYLE = {
  running: { template: "blue", label: "执行中" },
  success: { template: "green", label: "已完成" },
  failed: { template: "red", label: "执行失败" },
  cancelled: { template: "grey", label: "已取消" },
} as const;

const COMPACT_ANSWER_LENGTH = 900;
const MAX_CARD_ANSWER_LENGTH = 6_000;
const RUNNING_ACTIVITY_LIMIT = 3;
const FINISHED_ACTIVITY_LIMIT = 8;
const TEXT_CHUNK_LENGTH = 3_500;

const TOOL_ICONS: Record<string, string> = {
  Agent: "🧩",
  Bash: "⌘",
  Edit: "✏️",
  Glob: "📁",
  Grep: "🔎",
  MCP: "🔌",
  Read: "📄",
  Task: "🧩",
  TaskOutput: "⏳",
  WebFetch: "🌐",
  WebSearch: "🔍",
  Write: "📝",
};

// ─────────────────────────── 文本工具 ───────────────────────────

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1_000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
}

function formatCount(value: number): string {
  return value >= 1_000 ? `${Math.round(value / 100) / 10}k` : String(value);
}

function escapeInlineCode(value: string): string {
  return value.replaceAll("`", "ˋ");
}

/** 飞书 markdown 会把 <tag> 当标签解析，插入零宽连接符阻断。 */
export function escapeFeishuMarkdown(value: string): string {
  return value.replace(/<(?=\/?[A-Za-z][^>]*>)/g, "<&zwj;");
}

function markdownSplitIndex(text: string, maxLength: number): number {
  if (text.length <= maxLength) return text.length;
  const paragraph = text.lastIndexOf("\n\n", maxLength);
  if (paragraph >= maxLength * 0.55) return paragraph;
  const line = text.lastIndexOf("\n", maxLength);
  return line >= maxLength * 0.55 ? line : maxLength;
}

/** 截断处若落在代码块中间，补一个收尾围栏，避免卡片渲染错乱。 */
function closeOpenFence(markdown: string): string {
  const fences = markdown.match(/^```/gm)?.length ?? 0;
  return fences % 2 === 1 ? `${markdown}\n\n\`\`\`` : markdown;
}

function markdownPreview(text: string, maxLength: number): string {
  return closeOpenFence(text.slice(0, markdownSplitIndex(text, maxLength)).trim());
}

function compactAnswerPreview(answer: string): string {
  const fenceIndex = answer.search(/\n```/);
  const prose = fenceIndex > 0 ? answer.slice(0, fenceIndex) : answer;
  const preview = markdownPreview(prose, COMPACT_ANSWER_LENGTH)
    .replace(/\n(?:---|#{1,6}\s+[^\n]+)\s*$/, "")
    .trim();
  return preview.length >= 40
    ? preview
    : "回答包含较多代码与细节，展开后可以查看完整内容。";
}

export function splitLongText(text: string): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > TEXT_CHUNK_LENGTH) {
    const index = markdownSplitIndex(rest, TEXT_CHUNK_LENGTH);
    chunks.push(closeOpenFence(rest.slice(0, index).trim()));
    rest = rest.slice(index);
  }
  const tail = rest.trim();
  if (tail) chunks.push(tail);
  return chunks;
}

export function answerNeedsContinuation(answer: string): boolean {
  return answer.length > MAX_CARD_ANSWER_LENGTH;
}

export function answerContinuation(answer: string): string {
  return answer.slice(markdownSplitIndex(answer, MAX_CARD_ANSWER_LENGTH)).trim();
}

// ─────────────────────────── 组件片段 ───────────────────────────

function collapsibleHeader(title: string): Record<string, unknown> {
  return {
    title: { tag: "markdown", content: `**${title}**` },
    vertical_align: "center",
    icon: { tag: "standard_icon", token: "down-small-ccm_outlined" },
    icon_position: "right",
    icon_expanded_angle: -180,
  };
}

function activityLine(activity: TaskActivity): string {
  const icon = activity.failed ? "⚠️" : (TOOL_ICONS[activity.toolName] ?? "⚙️");
  const detail = activity.detail
    ? ` · \`${escapeInlineCode(activity.detail)}\``
    : "";
  const duration =
    activity.durationMs >= 1_000 ? ` · ${formatDuration(activity.durationMs)}` : "";
  return `${icon} ${activity.label}${detail}${duration}`;
}

function usageTotal(stats: CliRunStats | undefined): number | undefined {
  if (!stats) return undefined;
  if (stats.totalTokens !== undefined) return stats.totalTokens;
  const values = [
    stats.inputTokens,
    stats.outputTokens,
    stats.cacheReadTokens,
    stats.cacheCreationTokens,
  ].filter((value): value is number => value !== undefined);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : undefined;
}

function formatContextUsage(
  usedTokens: number | undefined,
  windowTokens: number | undefined,
): string | undefined {
  if (usedTokens === undefined) return undefined;
  if (windowTokens === undefined || windowTokens <= 0) {
    return `当前上下文约 ${formatCount(usedTokens)} tokens`;
  }
  // 累计消耗大于窗口是正常的，但那不是「当前上下文」，宁可不显示也不能自相矛盾。
  if (usedTokens > windowTokens) return undefined;
  const percentage = Math.round((usedTokens / windowTokens) * 100);
  return `当前上下文 ${formatCount(usedTokens)} / ${formatCount(windowTokens)}（${percentage}%）`;
}

function formatContextGrowth(
  usedTokens: number | undefined,
  startTokens: number | undefined,
  startedNewSession = false,
): string | undefined {
  if (usedTokens === undefined || startTokens === undefined) return undefined;
  const delta = usedTokens - startTokens;
  const change =
    delta >= 0
      ? `新增 ${formatCount(delta)}`
      : `减少 ${formatCount(Math.abs(delta))}`;
  return `${startedNewSession ? "新会话基础" : "本轮开始"} ${formatCount(startTokens)} · ${change}`;
}

function progressLines(progress: TaskProgressSnapshot): string[] {
  const lines = [
    `⏱️ 已运行 ${formatDuration(progress.elapsedMs)} · 工具 ${progress.completedCount}/${progress.toolCount}`,
  ];
  const usage = formatContextUsage(
    progress.contextUsedTokens,
    progress.contextWindowTokens,
  );
  if (usage) lines.push(usage);
  const growth = formatContextGrowth(
    progress.contextUsedTokens,
    progress.contextStartTokens,
    progress.startedNewSession,
  );
  if (growth) lines.push(growth);
  return lines;
}

function statsLines(stats: CliRunStats | undefined): string[] {
  if (!stats) return [];
  const lines: string[] = [];
  if (stats.durationMs !== undefined) {
    lines.push(`耗时 ${formatDuration(stats.durationMs)}`);
  }
  if (stats.turns !== undefined) lines.push(`轮次 ${stats.turns}`);
  const total = usageTotal(stats);
  if (total !== undefined) lines.push(`累计 tokens ${formatCount(total)}`);
  return lines;
}

// ─────────────────────────── 任务卡片 ───────────────────────────

export function buildTaskCard(options: TaskCardOptions): CardJson {
  const style = STATUS_STYLE[options.status];
  const running = options.status === "running";
  const progress = options.progress;
  const elements: Record<string, unknown>[] = [];

  if (options.answer) {
    // 完成后答案回到视觉中心，过程细节收进折叠区。
    const long = answerNeedsContinuation(options.answer);
    elements.push({
      tag: "markdown",
      content: escapeFeishuMarkdown(
        long
          ? markdownPreview(options.answer, MAX_CARD_ANSWER_LENGTH)
          : options.answer,
      ),
    });
    if (long) {
      elements.push({
        tag: "markdown",
        content: "_内容较长，剩余部分已作为消息发在同一话题中。_",
      });
    }
  } else {
    elements.push({
      tag: "markdown",
      content: `**${escapeFeishuMarkdown(options.detail)}**`,
    });
  }

  if (progress && running) {
    elements.push({ tag: "markdown", content: progressLines(progress).join("\n") });
    const recent = progress.activities.slice(0, RUNNING_ACTIVITY_LIMIT);
    if (recent.length) {
      elements.push({
        tag: "markdown",
        content: recent.map(activityLine).join("\n"),
      });
    }
  }

  const detailLines = [
    ...statsLines(options.stats),
    ...(progress ? progressLines(progress) : []),
  ];
  const finishedActivities = progress && !running
    ? progress.activities.slice(0, FINISHED_ACTIVITY_LIMIT)
    : [];
  if (!running && (detailLines.length || finishedActivities.length)) {
    elements.push({
      tag: "collapsible_panel",
      expanded: false,
      header: collapsibleHeader("执行详情"),
      vertical_spacing: "8px",
      padding: "8px 8px 8px 8px",
      elements: [
        ...(detailLines.length
          ? [{ tag: "markdown", content: detailLines.join("\n") }]
          : []),
        ...(finishedActivities.length
          ? [
              {
                tag: "markdown",
                content: finishedActivities.map(activityLine).join("\n"),
              },
            ]
          : []),
      ],
    });
  }

  if (options.technicalDetail) {
    // 错误标题给人看，技术细节收进折叠区，不抢走注意力。
    elements.push({
      tag: "collapsible_panel",
      expanded: false,
      header: collapsibleHeader("技术细节"),
      vertical_spacing: "8px",
      padding: "8px 8px 8px 8px",
      elements: [
        {
          tag: "markdown",
          content: `\`\`\`\n${escapeInlineCode(options.technicalDetail).slice(0, 1_000)}\n\`\`\``,
        },
      ],
    });
  }

  if (running && options.abortSessionId) {
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: "停止任务" },
      type: "danger_text",
      size: "small",
      behaviors: [
        {
          type: "callback",
          value: { action: "abort_task", sessionId: options.abortSessionId },
        },
      ],
    });
  }

  return {
    schema: "2.0",
    config: {
      // 共享卡片：更新会同步给所有看过这条消息的人。
      update_multi: true,
      summary: { content: `${options.title}：${style.label}` },
    },
    header: {
      template: style.template,
      title: { tag: "plain_text", content: options.title },
      subtitle: { tag: "plain_text", content: style.label },
    },
    body: { direction: "vertical", vertical_spacing: "12px", elements },
  };
}

// ─────────────────────────── 更新节流 ───────────────────────────

type UpdateCard = (card: CardJson) => Promise<void>;

/**
 * 窗口内无论 push 多少次，只提交最新的一张卡片。
 * CLI 事件几十毫秒一个，直接打到飞书会闪动、触发频控，也没有阅读价值。
 */
export class ThrottledCardUpdater {
  private pendingCard: CardJson | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** 串行化网络请求：旧请求晚到会把卡片退回旧状态。 */
  private updateChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly updateCard: UpdateCard,
    private readonly intervalMs = 1_000,
  ) {}

  push(card: CardJson): void {
    if (this.closed) return;
    this.pendingCard = card;
    this.schedule();
  }

  /** 终态卡片刷新失败只记录不抛出：卡片是展示层，不能反过来改写任务结果。 */
  async finish(finalCard: CardJson): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingCard = undefined;
    await this.updateChain.catch(() => undefined);
    try {
      await this.updateCard(finalCard);
    } catch (error) {
      console.error("[卡片] 终态刷新失败:", (error as Error).message);
    }
  }

  async cancel(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingCard = undefined;
    await this.updateChain.catch(() => undefined);
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushPending();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  private flushPending(): void {
    const card = this.pendingCard;
    this.pendingCard = undefined;
    if (!card || this.closed) return;
    this.updateChain = this.updateChain
      .then(() => this.updateCard(card))
      .catch((error) => {
        console.error("[卡片] 刷新失败:", (error as Error).message);
      })
      .finally(() => {
        if (this.pendingCard && !this.closed) this.schedule();
      });
  }
}

// ─────────────────────────── 通用状态卡 ───────────────────────────

export interface SessionNoticeCardOptions {
  title: string;
  detail: string;
  template?: "blue" | "green" | "grey" | "red";
}

export function buildSessionNoticeCard(
  options: SessionNoticeCardOptions,
): CardJson {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: options.title } },
    header: {
      template: options.template ?? "blue",
      title: { tag: "plain_text", content: options.title },
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      elements: [
        { tag: "markdown", content: escapeFeishuMarkdown(options.detail) },
      ],
    },
  };
}

// ─────────────────────────── /resume 卡片 ───────────────────────────

export interface ResumeCardOptions {
  agentSessionId: string;
  cliName: string;
  currentCliSessionId?: string;
  sessions: CliSessionSummary[];
}

function formatSessionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function buildResumeCard(options: ResumeCardOptions): CardJson {
  const elements: Record<string, unknown>[] = options.sessions.length
    ? options.sessions.flatMap((session, index) => {
        const current = session.id === options.currentCliSessionId;
        const row: Record<string, unknown> = {
          tag: "column_set",
          flex_mode: "none",
          horizontal_spacing: "12px",
          columns: [
            {
              tag: "column",
              width: "weighted",
              weight: 4,
              elements: [
                {
                  tag: "markdown",
                  content: `**${escapeFeishuMarkdown(session.title)}**\n_${formatSessionTime(session.updatedAt)} · ${session.id.slice(0, 8)}_`,
                },
              ],
            },
            {
              tag: "column",
              width: "auto",
              vertical_align: "center",
              elements: current
                ? [{ tag: "markdown", content: "**当前会话**" }]
                : [
                    {
                      tag: "button",
                      text: { tag: "plain_text", content: "恢复" },
                      type: "primary_filled",
                      size: "medium",
                      behaviors: [
                        {
                          type: "callback",
                          value: {
                            action: "resume_cli_session",
                            agentSessionId: options.agentSessionId,
                            cliSessionId: session.id,
                          },
                        },
                      ],
                    },
                  ],
            },
          ],
        };
        return index === options.sessions.length - 1 ? [row] : [row, { tag: "hr" }];
      })
    : [
        {
          tag: "markdown",
          content:
            "当前工作目录里还没有可以恢复的 CLI 会话。先完成一次任务，再用 `/new` 开启新会话。",
        },
      ];

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: `${options.cliName}：选择历史会话` },
    },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "恢复历史会话" },
      subtitle: { tag: "plain_text", content: options.cliName },
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      elements: [
        {
          tag: "markdown",
          content: "选择后，当前话题会继续使用对应的 CLI 上下文。",
        },
        ...elements,
      ],
    },
  };
}

// ─────────────────────────── /history 卡片 ───────────────────────────

/** 沿用任务卡的状态词汇，避免「卡片上叫已完成、历史里叫成功」两套说法。 */
const HISTORY_STATUS_LABEL: Record<TaskRecordStatus, string> = {
  success: "✅ 已完成",
  forwarded: "🤝 已交接",
  // 「等待确认」说的是任务停在这儿等人，不能和「已完成」共用一套说法——
  // 用户在列表里一眼看到的就是这几个字，说错了他会以为这件事已经不用管了。
  waiting: "⏸️ 等待确认",
  failed: "❌ 执行失败",
  cancelled: "⏹️ 已取消",
  // 老记录：当时的 handoff 同时表示「已交接」和「等人拍板」，标明来历，别让人当成已完成。
  handoff: "🤝 已交接（旧记录）",
};

/**
 * 详情卡头部配色跟着结局走：真做完了才给绿色（交接是完成之后的流转，同样算做完）。
 * 等人拍板的用橙色：红色已经是「执行失败」的语义，占用它会让「等你回话」看起来像出了故障。
 * 老记录含义不明，给中性灰，不能凭一半的概率涂成绿色。
 */
const HISTORY_STATUS_TEMPLATE: Record<TaskRecordStatus, string> = {
  success: "green",
  forwarded: "green",
  waiting: "orange",
  failed: "red",
  cancelled: "grey",
  handoff: "grey",
};

/**
 * 来源给人看的说法。resume 是澄清或审批拍板之后接着跑的那一轮，
 * 不是用户又发了一条指令——两者混为一谈的话，历史里会凭空多出没人发过的任务。
 */
const HISTORY_ORIGIN_LABEL: Record<TaskRunOrigin, string> = {
  user: "话题内发起",
  schedule: "定时触发",
  handoff: "团队交接",
  resume: "澄清或审批后续跑",
};

/**
 * 筛选档给人看的说法。内核只存筛选值，文案留在卡片层——
 * 「已停止」对应的记录状态是 cancelled，那是用户按下「停止任务」的结果。
 */
const HISTORY_FILTER_LABEL: Record<TaskHistoryFilter, string> = {
  all: "全部",
  success: "成功",
  failed: "失败",
  cancelled: "已停止",
};

/** 一行只放得下一句话，超出就截断。 */
const HISTORY_SUMMARY_LENGTH = 40;
/** open_id 退化显示时保留的前缀长度：够区分不同的人，又不至于挤掉整行。 */
const OWNER_ID_LENGTH = 10;

/** 记录里的 title 是引擎名（任务卡标题），认任务还得靠指令原文的第一句。 */
function historySummary(record: Pick<TaskRecord, "prompt"> & { title?: string }): string {
  const firstLine = record.prompt
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const text = firstLine || record.title || "（没有指令内容）";
  return text.length > HISTORY_SUMMARY_LENGTH
    ? `${text.slice(0, HISTORY_SUMMARY_LENGTH)}…`
    : text;
}

/**
 * 人在群里发起的任务只留下了 open_id——飞书消息事件不带发送者昵称，
 * 为一张历史卡片去查通讯录既慢又要多一份权限，所以退化成短 id：
 * 认不出是谁，至少认得出「不是同一个人」。
 */
function historyOwner(
  record: Pick<TaskRecord, "ownerOpenId" | "origin"> & { ownerName?: string },
): string {
  if (record.ownerName) return record.ownerName;
  if (record.origin === "schedule") return "定时任务";
  if (!record.ownerOpenId) return "未知发起人";
  return record.ownerOpenId.length > OWNER_ID_LENGTH
    ? `${record.ownerOpenId.slice(0, OWNER_ID_LENGTH)}…`
    : record.ownerOpenId;
}

/**
 * 翻页和筛选共用一套卡片状态：两种按钮回带同样的四个字段，
 * 谁也不能只带自己那一半，否则翻一页就把筛选丢了、换一次筛选就把页码丢了。
 * botId / chatId 是回写的作用域——卡片可以被转发，回调侧要拿它和实际位置对齐。
 */
function historyActionValue(
  options: HistoryCardOptions,
  targetPage: number,
  filter: TaskHistoryFilter,
): Record<string, unknown> {
  return {
    action: "history_page",
    botId: options.botId,
    chatId: options.chatId,
    page: targetPage,
    filter,
  };
}

/**
 * 详情按钮除了记录 id，还要回带「现在停在哪一页、哪个筛选」，详情卡的「返回列表」原样带回来。
 * 取的是查询收敛之后的值（page.page / page.filter），不是调用方请求的原值——
 * 越界页码和非法筛选都被收敛过，用户眼前的这一页才是他要返回的那一页。
 */
/**
 * 详情按钮回带的东西。取最小形状而不是整个列表卡选项——
 * 时间线上的「查看」按钮也要用它，而详情卡手里没有列表页那份数据。
 */
function historyDetailValue(
  options: { botId: string; chatId: string; page: number; filter: TaskHistoryFilter },
  recordId: string,
): Record<string, unknown> {
  return {
    action: "history_detail",
    botId: options.botId,
    chatId: options.chatId,
    recordId,
    page: options.page,
    filter: options.filter,
  };
}

function historyPagerButton(
  options: HistoryCardOptions,
  label: string,
  targetPage: number,
  primary: boolean,
): Record<string, unknown> {
  return {
    tag: "column",
    width: "weighted",
    weight: 1,
    elements: [
      {
        tag: "button",
        text: { tag: "plain_text", content: label },
        type: primary ? "primary" : "default",
        width: "fill",
        size: "medium",
        behaviors: [
          {
            type: "callback",
            value: historyActionValue(options, targetPage, options.page.filter),
          },
        ],
      },
    ],
  };
}

/**
 * 四个筛选入口。当前档用实心按钮 + 「✓」前缀双重标记：
 * 只靠颜色的话，筛掉之后剩一张空列表，用户分不清是筛没了还是压根没有记录。
 * 切档一律回第一页——原来的页码在新的结果集里多半根本不存在。
 */
function historyFilterRow(options: HistoryCardOptions): Record<string, unknown> {
  const active = options.page.filter;
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "8px",
    columns: TASK_HISTORY_FILTERS.map((filter) => ({
      tag: "column",
      width: "weighted",
      weight: 1,
      elements: [
        {
          tag: "button",
          text: {
            tag: "plain_text",
            content:
              filter === active
                ? `✓ ${HISTORY_FILTER_LABEL[filter]}`
                : HISTORY_FILTER_LABEL[filter],
          },
          type: filter === active ? "primary_filled" : "default",
          width: "fill",
          size: "medium",
          behaviors: [
            {
              type: "callback",
              value: historyActionValue(options, 1, filter),
            },
          ],
        },
      ],
    })),
  };
}

export interface HistoryCardOptions {
  botName: string;
  /** 翻页按钮要带回作用域，光有展示用的 botName 不够。 */
  botId: string;
  chatId: string;
  page: TaskHistoryPage;
}

export function buildHistoryCard(options: HistoryCardOptions): CardJson {
  const { page } = options;
  const botName = escapeFeishuMarkdown(options.botName);
  const rows: Record<string, unknown>[] = page.tasks.flatMap(
    (task, index) => {
      // 摘要在左、详情按钮在右，形态对齐 /resume 卡：一行读得完，要细节再点开。
      const row = {
        tag: "column_set",
        flex_mode: "none",
        horizontal_spacing: "12px",
        columns: [
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            vertical_align: "center",
            elements: [
              {
                tag: "markdown",
                content: [
                  `**${HISTORY_STATUS_LABEL[task.status]} ${escapeFeishuMarkdown(historySummary(task))}**`,
                  [
                    formatSessionTime(task.startedAt),
                    escapeFeishuMarkdown(historyOwner(task)),
                    // 耗时是各轮之和，不是首尾差：中间等人的时间不算引擎在干活
                    formatDuration(task.durationMs),
                    // 多轮才写。一轮的事写「1 轮」是噪音。
                    ...(task.turns.length > 1 ? [`${task.turns.length} 轮`] : []),
                  ]
                    .map((part) => `_${part}_`)
                    .join(" · "),
                ].join("\n"),
              },
            ],
          },
          {
            tag: "column",
            width: "auto",
            vertical_align: "center",
            elements: [
              {
                tag: "button",
                text: { tag: "plain_text", content: "详情" },
                type: "default",
                size: "medium",
                behaviors: [
                  {
                    type: "callback",
                    value: historyDetailValue(
                      { ...options, page: page.page, filter: page.filter },
                      task.latestRecordId,
                    ),
                  },
                ],
              },
            ],
          },
        ],
      };
      return index === page.tasks.length - 1 ? [row] : [row, { tag: "hr" }];
    },
  );

  const filterLabel = HISTORY_FILTER_LABEL[page.filter];
  // 位置信息要对任何一页都成立，不能写成「最新 5 条」——翻到第二页就成了假话。
  const listed = [
    `${botName} 在本群最近的任务，按发起时间倒序，跨话题。`,
    `筛选：${filterLabel} · 当前第 ${page.page}/${page.pageCount} 页，共 ${page.total} 条。`,
  ].join("\n");
  // 两种空列表长得一模一样，说错一种用户就会以为记录丢了，所以文案必须分开。
  const emptyByFilter = [
    `${botName} 在本群没有「${filterLabel}」的任务记录。`,
    `本群一共有 ${page.scopeTotal} 条历史，点下方的「全部」就能看回来。`,
  ].join("\n");
  const noHistory = `${botName} 在这个群里还没有任务记录。\n直接 @ 我说清楚要做什么，任务结束后就会出现在这里。`;
  const intro = page.total ? listed : page.scopeTotal ? emptyByFilter : noHistory;

  // 首页不给「上一页」、末页不给「下一页」：点了也没有内容，不如不出现。
  const pagerColumns: Record<string, unknown>[] = [];
  if (page.hasPrevious) {
    pagerColumns.push(
      historyPagerButton(options, "← 上一页（更近）", page.page - 1, false),
    );
  }
  if (page.hasNext) {
    pagerColumns.push(
      historyPagerButton(options, "下一页（更早）→", page.page + 1, true),
    );
  }
  const pager = pagerColumns.length
    ? [
        { tag: "hr" },
        {
          tag: "column_set",
          flex_mode: "bisect",
          horizontal_spacing: "12px",
          columns: pagerColumns,
        },
      ]
    : [];

  // 标题上的条数跟着筛选走，和正文里的「共 N 条」是同一个数，不然两处对不上。
  const scopeSuffix = page.filter === "all" ? "" : `${filterLabel} · `;
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: `历史任务：${scopeSuffix}共 ${page.total} 条` },
    },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "历史任务" },
      subtitle: {
        tag: "plain_text",
        content: `${options.botName} · ${scopeSuffix}共 ${page.total} 条`,
      },
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      elements: [
        { tag: "markdown", content: intro },
        // 筛选放在列表上方：它决定下面能看到什么，先看到入口才不会把空列表当成没记录。
        // 一条历史都没有时不给筛选，四个按钮点下去只会得到四张同样的空卡片。
        ...(page.scopeTotal ? [historyFilterRow(options)] : []),
        ...(rows.length ? [{ tag: "hr" }] : []),
        ...rows,
        ...pager,
      ],
    },
  };
}

/** 一行放完执行统计：引擎没报轮次或 tokens 时就不占位，别显示「轮次 0」。 */
function historyStatsLine(record: TaskRecord): string {
  const parts = [`⏱️ 耗时 ${formatDuration(record.durationMs)}`];
  if (record.turns !== undefined) parts.push(`🔁 轮次 ${record.turns}`);
  parts.push(`🛠️ 工具 ${record.completedToolCount}/${record.toolCount}`);
  if (record.totalTokens !== undefined) {
    parts.push(`🎫 累计 tokens ${formatCount(record.totalTokens)}`);
  }
  // 重试过才写。一轮跑了 40 分钟，是一次跑完的还是断了两次接上的，
  // 光看耗时分不出来，而这两件事的含义完全不同。
  if (record.retries) parts.push(`♻️ 重试 ${record.retries} 次`);
  if (record.subagents?.length) {
    parts.push(`🧩 子 Agent ${record.subagents.join(" / ")}`);
  }
  return parts.join(" · ");
}

/** 话题和工作目录是「该回哪儿追问、改的是哪份代码」，路径原样给出，不做省略。 */
function historyContextLines(record: TaskRecord): string {
  return [
    `所属话题 \`${escapeInlineCode(record.threadId)}\``,
    `工作目录 \`${escapeInlineCode(record.workspaceDir)}\``,
    `发起人 ${escapeFeishuMarkdown(historyOwner(record))} · 来源 ${HISTORY_ORIGIN_LABEL[record.origin]}`,
  ].join("\n");
}

export interface HistoryDetailCardOptions {
  botName: string;
  /** 「返回列表」也要带回作用域，回调侧同样要和实际点击位置对齐。 */
  botId: string;
  chatId: string;
  record: TaskRecord;
  /** 点开详情前停在哪一页、哪个筛选，「返回列表」原样带回去。 */
  page: number;
  filter: TaskHistoryFilter;
  /**
   * 这一轮改了文件却没有任何验证子 Agent 的痕迹。判断在 app 层做好后传进来，
   * 卡片只负责把它画出来——判断规则会变，画法不会。
   */
  unverified?: boolean;
  /**
   * 这件事的全部轮次，按时间正序。只有一轮时不传或传一条都行——
   * 一轮的事画时间线是噪音。
   */
  turns?: TaskRecord[];
}

/**
 * 一件事的时间线。
 *
 * 列表改成按「事」列之后，详情按钮只指向最后一轮，早期轮次在界面上就够不着了——
 * 真实数据里当场有 19 条记录变成不可达。归组和时间线是一件事的两半，
 * 只做前一半就是把信息藏起来。
 */
function historyTimeline(
  options: HistoryDetailCardOptions,
  turns: TaskRecord[],
): Record<string, unknown>[] {
  return [
    { tag: "hr" },
    {
      tag: "markdown",
      content: `**这件事共 ${turns.length} 轮**`,
    },
    ...turns.map((turn, index) => {
      const current = turn.id === options.record.id;
      return {
        tag: "column_set",
        flex_mode: "none",
        horizontal_spacing: "12px",
        columns: [
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            vertical_align: "center",
            elements: [
              {
                tag: "markdown",
                content:
                  `${index + 1}. ${HISTORY_STATUS_LABEL[turn.status]} · ` +
                  `${HISTORY_ORIGIN_LABEL[turn.origin]} · ` +
                  `${formatSessionTime(turn.startedAt)} · ${formatDuration(turn.durationMs)}` +
                  // 当前这一轮不给按钮，改成标出来：点它只会刷出同一张卡片
                  (current ? " · **正在看**" : ""),
              },
            ],
          },
          ...(current
            ? []
            : [
                {
                  tag: "column",
                  width: "auto",
                  vertical_align: "center",
                  elements: [
                    {
                      tag: "button",
                      text: { tag: "plain_text", content: "查看" },
                      type: "default",
                      size: "small",
                      behaviors: [
                        {
                          type: "callback",
                          value: historyDetailValue(options, turn.id),
                        },
                      ],
                    },
                  ],
                },
              ]),
        ],
      };
    }),
  ];
}

export function buildHistoryDetailCard(
  options: HistoryDetailCardOptions,
): CardJson {
  const { record } = options;
  const statusLabel = HISTORY_STATUS_LABEL[record.status];
  const elements: Record<string, unknown>[] = [
    {
      tag: "markdown",
      content: [
        `**${statusLabel} ${escapeFeishuMarkdown(historySummary(record))}**`,
        `_${formatSessionTime(record.startedAt)} · ${escapeFeishuMarkdown(historyOwner(record))}_`,
      ].join("\n"),
    },
    { tag: "hr" },
    {
      tag: "markdown",
      // 落盘按字符数硬截断，截断处正好落在代码块中间时要补一个收尾围栏，否则整张卡片渲染错乱。
      content: record.answer
        ? escapeFeishuMarkdown(closeOpenFence(record.answer))
        : "_这一轮没有留下答案。_",
    },
  ];

  if (record.answerTruncated) {
    // 说清是落盘时截断的：不写这一句，用户会以为模型当时只输出了这么多。
    // 指路必须点名记录所属的那个话题：/history 是跨话题的，写成「本话题」会让
    // 从别的话题翻历史的人，去一个根本没有那张任务卡片的地方找完整答案。
    elements.push({
      tag: "markdown",
      content: `_答案过长，历史里只留了前 ${TASK_ANSWER_LIMIT} 字，完整内容见话题 \`${escapeInlineCode(record.threadId)}\` 里当时那张任务卡片。_`,
    });
  }

  // 「等人拍板」不是结局，详情里必须说清它停在哪儿：
  // 不写这一句，一条卡在审批上的记录看起来和一次没留下答案的正常执行一模一样。
  if (record.status === "waiting") {
    elements.push({
      tag: "markdown",
      // 记录一条一轮、写下就不再改。所以这句只陈述「这一轮停在哪儿」，
      // 不说「现在还没有结论」——人可能早就拍完板了，后续进展是另一条记录。
      content: `_这一轮停在了等人拍板那一步（审批 / 需求澄清 / 产品方案），没有在本轮给出结论。后续进展见话题 \`${escapeInlineCode(record.threadId)}\` 里那张卡片。_`,
    });
  }

  // 说的是「没有证据表明验过」，不是「做错了」。措辞要撑得住这个区别：
  // 活可能干得很好，只是没留下验证的痕迹；说成失败和说成成功一样是撒谎。
  // 原地转只是提示，不是判决：它可能真的卡住了，也可能只是那一段确实要反复确认。
  // 所以措辞给的是「值得看一眼」，不是「它错了」。
  if (record.spinningOn) {
    elements.push({
      tag: "markdown",
      content:
        `_🔁 这一轮里 ${escapeFeishuMarkdown(record.spinningOn)} 连着重复了很多次，` +
        "中间没有改过文件——可能是卡在同一个地方了，值得看一眼。_",
    });
  }
  if (options.unverified) {
    elements.push({
      tag: "markdown",
      content:
        "_⚠️ 这一轮改了文件，但没有 tester / code-reviewer 的痕迹——" +
        "结果没问题的可能性很大，只是没人复核过。要紧的改动值得自己再看一眼。_",
    });
  }
  const turns = options.turns ?? [];
  elements.push(
    ...(turns.length > 1 ? historyTimeline(options, turns) : []),
    { tag: "markdown", content: historyStatsLine(record) },
    { tag: "markdown", content: historyContextLines(record) },
  );

  if (record.failureReason) {
    // 和任务卡同一套约定：结论留在上面，技术原因收进折叠区，不抢注意力。
    elements.push({
      tag: "collapsible_panel",
      expanded: false,
      header: collapsibleHeader("技术细节"),
      vertical_spacing: "8px",
      padding: "8px 8px 8px 8px",
      elements: [
        {
          tag: "markdown",
          content: `\`\`\`\n${escapeInlineCode(record.failureReason).slice(0, 1_000)}\n\`\`\``,
        },
      ],
    });
  }

  elements.push(
    { tag: "hr" },
    {
      tag: "button",
      text: { tag: "plain_text", content: "← 返回列表" },
      type: "default",
      size: "medium",
      behaviors: [
        {
          type: "callback",
          // 复用列表的 action：返回列表就是「按这一页这一档再渲染一次」，
          // 单开一个 action 只会多出一份要跟着列表一起维护的作用域校验。
          value: {
            action: "history_page",
            botId: options.botId,
            chatId: options.chatId,
            page: options.page,
            filter: options.filter,
          },
        },
      ],
    },
  );

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: `任务详情：${statusLabel}` },
    },
    header: {
      template: HISTORY_STATUS_TEMPLATE[record.status],
      title: { tag: "plain_text", content: "任务详情" },
      subtitle: {
        tag: "plain_text",
        content: `${options.botName} · ${statusLabel}`,
      },
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      elements,
    },
  };
}

// ─────────────────────────── 协作卡片 ───────────────────────────

export interface CollaborationCardOptions {
  senderName: string;
  targetName: string;
  workspaceName: string;
  prompt: string;
  /** forward = 派新活，return = 把结果交回来源。round 推断不出方向，必须显式传。 */
  kind: "forward" | "return";
  round: number;
  maxRounds: number;
}

export function buildCollaborationCard(
  options: CollaborationCardOptions,
): CardJson {
  const isForward = options.kind === "forward";
  const isLastRound = options.round >= options.maxRounds;
  const title = isForward ? "任务已派发" : "结果已返回";
  const action = isForward ? "请接手处理" : "请确认并处理反馈";
  const description = isForward
    ? "上一环节已经完成，现在交给你继续。"
    : "对方已经完成，反馈已交回。";
  const footer = isLastRound
    ? "这是本次协作的最后一轮，处理完成后流程结束。"
    : `完成后，结果会自动交回 ${options.senderName}。`;

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: {
        content: `${title}：${options.senderName} → ${options.targetName}`,
      },
    },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: title },
      subtitle: {
        tag: "plain_text",
        content: `${options.senderName} → ${options.targetName} · 第 ${options.round}/${options.maxRounds} 轮`,
      },
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      elements: [
        {
          tag: "markdown",
          content: `**${escapeFeishuMarkdown(options.targetName)}，${action}**\n\n${description}`,
        },
        {
          tag: "markdown",
          content: `**项目**\n${escapeFeishuMarkdown(options.workspaceName)}`,
        },
        {
          tag: "collapsible_panel",
          expanded: false,
          header: collapsibleHeader(isForward ? "查看任务说明" : "查看反馈内容"),
          vertical_spacing: "8px",
          padding: "8px 8px 8px 8px",
          elements: [
            {
              tag: "markdown",
              content: escapeFeishuMarkdown(
                markdownPreview(options.prompt, MAX_CARD_ANSWER_LENGTH),
              ),
            },
          ],
        },
        { tag: "hr" },
        { tag: "markdown", content: `_${footer}_` },
      ],
    },
  };
}

// ─────────────────────────── /team 卡片 ───────────────────────────

export interface TeamCardMember {
  id: string;
  displayName: string;
  role: string;
  cliName: string;
  skills: string[];
  isLeader: boolean;
  ready: boolean;
}

export function buildTeamCard(options: { members: TeamCardMember[] }): CardJson {
  const leader = options.members.find((member) => member.isLeader);
  const memberElements = options.members.map((member) => {
    const badges = [
      member.isLeader ? "Team Leader" : "",
      member.ready ? "已连接" : "未连接",
    ]
      .filter(Boolean)
      .join(" · ");
    const skills = member.skills.length
      ? member.skills.map((skill) => `$${skill}`).join("、")
      : "无";
    return {
      tag: "markdown",
      content: [
        `**${escapeFeishuMarkdown(member.displayName)}** _${badges}_`,
        escapeFeishuMarkdown(member.role),
        `引擎：${escapeFeishuMarkdown(member.cliName)}　Skill：${escapeFeishuMarkdown(skills)}`,
      ].join("\n"),
    };
  });

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: `Agent 团队：${options.members.length} 位成员` },
    },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "Agent 团队" },
      subtitle: {
        tag: "plain_text",
        content: leader
          ? `${options.members.length} 位成员 · ${leader.displayName} 负责统筹`
          : `${options.members.length} 位成员`,
      },
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      elements: [
        {
          tag: "markdown",
          content:
            "每位成员使用自己的飞书身份、执行引擎和项目 Skill，工作目录与会话彼此独立。",
        },
        { tag: "hr" },
        ...memberElements,
      ],
    },
  };
}

// ─────────────────────────── 需求澄清卡片 ───────────────────────────

function clarificationAnswerSummary(flow: ClarificationFlow): string {
  return flow.answers
    .map((answer, index) =>
      [
        `${index + 1}. **${escapeFeishuMarkdown(answer.prompt)}**`,
        `${answer.source === "agent" ? "Agent 推荐" : "你的选择"}：${escapeFeishuMarkdown(answer.answer)}`,
      ].join("\n"),
    )
    .join("\n\n");
}

function clarificationOptionButton(
  flow: ClarificationFlow,
  question: ClarificationFlow["request"]["questions"][number],
  option: { id: string; label: string },
): Record<string, unknown> {
  const recommendedOptionId =
    question.recommendedOptionId ?? question.options[0]?.id;
  return {
    tag: "button",
    text: {
      tag: "plain_text",
      content:
        option.id === recommendedOptionId && !option.label.includes("推荐")
          ? `${option.label}（推荐）`
          : option.label,
    },
    type: "default",
    width: "fill",
    size: "medium",
    behaviors: [
      {
        type: "callback",
        value: {
          action: "answer_clarification",
          flowToken: flow.token,
          questionId: question.id,
          optionId: option.id,
        },
      },
    ],
  };
}

function clarificationDecisionButton(
  flow: ClarificationFlow,
  questionId: string,
  decisionMode: "current" | "remaining",
): Record<string, unknown> {
  return {
    tag: "button",
    text: {
      tag: "plain_text",
      content:
        decisionMode === "current" ? "这一题交给 Agent 决定" : "按推荐方案继续",
    },
    type: decisionMode === "remaining" ? "primary" : "default",
    width: "fill",
    size: "medium",
    behaviors: [
      {
        type: "callback",
        value: {
          action: "answer_clarification",
          flowToken: flow.token,
          questionId,
          decisionMode,
        },
      },
    ],
  };
}

export function buildClarificationCard(options: {
  flow: ClarificationFlow;
}): CardJson {
  const { flow } = options;
  const question = flow.request.questions[flow.currentIndex];
  if (!question) {
    return buildSessionNoticeCard({
      title: flow.request.title,
      template: "grey",
      detail: "这组问题已经全部回答完成。",
    });
  }
  const current = flow.currentIndex + 1;
  const total = flow.request.questions.length;

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: `${flow.request.title}（${current}/${total}）` },
    },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: flow.request.title },
      subtitle: { tag: "plain_text", content: `${current} / ${total}` },
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      elements: [
        ...(flow.request.intro && flow.currentIndex === 0
          ? [{ tag: "markdown", content: escapeFeishuMarkdown(flow.request.intro) }]
          : []),
        ...(flow.answers.length
          ? [
              {
                tag: "markdown",
                content: `**已确认 ${flow.answers.length} 项**\n\n${clarificationAnswerSummary(flow)}`,
              },
              { tag: "hr" },
            ]
          : []),
        {
          tag: "markdown",
          content: `**${escapeFeishuMarkdown(question.prompt)}**\n\n选择最符合预期的一项：`,
        },
        ...question.options.map((option) =>
          clarificationOptionButton(flow, question, option),
        ),
        clarificationDecisionButton(flow, question.id, "current"),
        { tag: "hr" },
        {
          tag: "form",
          name: `clarify_${flow.token.slice(0, 8)}`,
          vertical_spacing: "8px",
          elements: [
            {
              tag: "input",
              name: "custom_answer",
              placeholder: {
                tag: "plain_text",
                content: "都不合适？在这里写下你的答案",
              },
              max_length: 500,
            },
            {
              tag: "button",
              name: "submit_custom",
              action_type: "form_submit",
              text: { tag: "plain_text", content: "提交自定义答案" },
              type: "primary",
              width: "default",
              size: "medium",
              value: {
                action: "answer_clarification",
                flowToken: flow.token,
                questionId: question.id,
                custom: true,
              },
            },
          ],
        },
        { tag: "hr" },
        {
          tag: "markdown",
          content:
            "不想逐项选择？Agent 会保留你已经确认的答案，并为剩余问题采用推荐方案。",
        },
        clarificationDecisionButton(flow, question.id, "remaining"),
      ],
    },
  };
}

export function buildClarificationContinuingCard(
  flow: ClarificationFlow,
): CardJson {
  return buildSessionNoticeCard({
    title: `${flow.request.title} · 正在整理`,
    template: "blue",
    detail: [
      "**答案已收到**",
      "正在基于这些选择继续整理，无需重复点击。",
      `**已确认 ${flow.answers.length} 项**\n\n${clarificationAnswerSummary(flow)}`,
    ].join("\n\n"),
  });
}

export function buildClarificationSupersededCard(
  flow: ClarificationFlow,
): CardJson {
  return buildSessionNoticeCard({
    title: `${flow.request.title} · 已更新`,
    template: "grey",
    detail: [
      "**已收到你在话题里的新消息**",
      "这张卡片已经失效，Agent OS 正在沿用同一个任务上下文处理新的补充。",
      flow.answers.length
        ? `此前已确认 ${flow.answers.length} 项，相关答案会一并带入。`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
}

// ─────────────────────────── 产品方案卡片 ───────────────────────────

function productDocumentList(flow: ProductSpecFlow): string {
  if (flow.request.deliveryMode === "lark-doc") {
    return `☁️ **飞书云文档** · [打开文档](${flow.request.documentUrl})`;
  }
  return [
    `📘 **Spec** · \`${escapeInlineCode(flow.request.specPath)}\``,
    `🎫 **Tickets** · \`${escapeInlineCode(flow.request.ticketsPath)}\``,
  ].join("\n");
}

export function buildProductSpecApprovalCard(flow: ProductSpecFlow): CardJson {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: `${flow.request.title}：待确认` },
    },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "产品方案已生成" },
      subtitle: {
        tag: "plain_text",
        content:
          flow.request.deliveryMode === "lark-doc"
            ? "飞书云文档待确认"
            : "本地 Spec · Tickets 待确认",
      },
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      elements: [
        {
          tag: "markdown",
          content: [
            `**${escapeFeishuMarkdown(flow.request.title)}**`,
            escapeFeishuMarkdown(flow.request.summary),
          ].join("\n\n"),
        },
        { tag: "hr" },
        { tag: "markdown", content: `**共享产物**\n${productDocumentList(flow)}` },
        {
          tag: "button",
          text: { tag: "plain_text", content: "确认产品方案" },
          type: "primary_filled",
          width: "fill",
          size: "medium",
          behaviors: [
            {
              type: "callback",
              value: { action: "approve_product_spec", flowToken: flow.token },
            },
          ],
        },
        {
          tag: "markdown",
          content: "_需要调整时，直接在本话题里 @产品经理 说明意见即可。_",
        },
      ],
    },
  };
}

export function buildProductSpecApprovedCard(flow: ProductSpecFlow): CardJson {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: `${flow.request.title}：已确认` },
    },
    header: {
      template: "green",
      title: { tag: "plain_text", content: "产品方案已确认" },
      subtitle: { tag: "plain_text", content: "产品阶段已就绪" },
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      elements: [
        {
          tag: "markdown",
          content: [
            `**${escapeFeishuMarkdown(flow.request.title)}**`,
            escapeFeishuMarkdown(flow.request.summary),
            `**已确认文档**\n${productDocumentList(flow)}`,
            flow.approvedAt ? `确认时间：${formatSessionTime(flow.approvedAt)}` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
    },
  };
}

export function buildProductSpecExpiredCard(flow: ProductSpecFlow): CardJson {
  return buildSessionNoticeCard({
    title: "产品方案确认已失效",
    template: "grey",
    detail: [
      `**${flow.request.title}**`,
      "同一任务已经提交了更新的产品方案，请查看话题中最新的确认卡。",
    ].join("\n\n"),
  });
}

// ─────────────────────────── 审批卡片 ───────────────────────────

const RISK_STYLE = {
  low: { template: "blue", label: "低风险" },
  medium: { template: "orange", label: "中风险" },
  high: { template: "red", label: "高风险" },
} as const;

export function buildApprovalCard(flow: ApprovalFlow): CardJson {
  const risk = RISK_STYLE[flow.request.risk];
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: `等待审批：${flow.request.title}` },
    },
    header: {
      template: risk.template,
      title: { tag: "plain_text", content: "高危操作待审批" },
      subtitle: { tag: "plain_text", content: risk.label },
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      elements: [
        {
          tag: "markdown",
          content: [
            `**${escapeFeishuMarkdown(flow.request.title)}**`,
            escapeFeishuMarkdown(flow.request.summary),
          ].join("\n\n"),
        },
        {
          tag: "markdown",
          content: `**影响范围**\n${escapeFeishuMarkdown(flow.request.impact)}`,
        },
        ...(flow.request.command
          ? [
              {
                tag: "markdown",
                content: `**将要执行**\n\`\`\`\n${escapeInlineCode(flow.request.command)}\n\`\`\``,
              },
            ]
          : []),
        { tag: "hr" },
        {
          tag: "column_set",
          flex_mode: "bisect",
          horizontal_spacing: "12px",
          columns: [
            {
              tag: "column",
              width: "weighted",
              weight: 1,
              elements: [
                {
                  tag: "button",
                  text: { tag: "plain_text", content: "批准执行" },
                  type: "danger_filled",
                  width: "fill",
                  size: "medium",
                  behaviors: [
                    {
                      type: "callback",
                      value: {
                        action: "decide_approval",
                        flowToken: flow.token,
                        decision: "approved",
                      },
                    },
                  ],
                },
              ],
            },
            {
              tag: "column",
              width: "weighted",
              weight: 1,
              elements: [
                {
                  tag: "button",
                  text: { tag: "plain_text", content: "拒绝" },
                  type: "default",
                  width: "fill",
                  size: "medium",
                  behaviors: [
                    {
                      type: "callback",
                      value: {
                        action: "decide_approval",
                        flowToken: flow.token,
                        decision: "rejected",
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          tag: "markdown",
          content: `_只有任务发起人可以拍板；${formatSessionTime(flow.expiresAt)} 前未处理将视为未批准。_`,
        },
      ],
    },
  };
}

export function buildApprovalDecidedCard(flow: ApprovalFlow): CardJson {
  const outcome = {
    approved: { template: "green" as const, label: "已批准" },
    rejected: { template: "grey" as const, label: "已拒绝" },
    expired: { template: "grey" as const, label: "已超时" },
    pending: { template: "blue" as const, label: "等待中" },
  }[flow.status];
  return buildSessionNoticeCard({
    title: `高危操作${outcome.label}`,
    template: outcome.template,
    detail: [
      `**${flow.request.title}**`,
      escapeFeishuMarkdown(flow.request.summary),
      flow.decidedAt ? `处理时间：${formatSessionTime(flow.decidedAt)}` : "",
      flow.status === "approved"
        ? "开发者会话已恢复，将继续执行。"
        : "开发者会话已恢复，不会执行该操作。",
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
}

// ─────────────────────────── 成本卡片 ───────────────────────────

export interface CostCardOptions {
  botName: string;
  summary: CostSummary;
  /** 历史保留上限，用来说清这份账单的边界。 */
  capacity: number;
}

/**
 * 成本一目了然，是为了让「值不值」这个判断有依据。
 * 真实数据里自动互审一度吃掉四分之三的 token，而那个数字当时是人手工算出来的——
 * 算不出来的成本等于没有刹车。
 */
export function buildCostCard(options: CostCardOptions): CardJson {
  const { summary } = options;
  const pct = (n: number) =>
    summary.totalTokens ? Math.round((n / summary.totalTokens) * 100) : 0;
  const lines = [
    `**${formatCount(summary.totalTokens)} tokens** · 引擎时长 ${formatDuration(summary.totalDurationMs)}`,
    `${summary.taskCount} 件事 · ${summary.turnCount} 轮执行`,
  ];
  const originRows = summary.byOrigin.map(
    (row) =>
      `${HISTORY_ORIGIN_LABEL[row.origin]} · ${row.turns} 轮 · ` +
      `${formatCount(row.tokens)} · ${pct(row.tokens)}%`,
  );
  const topRows = summary.topTasks.map(
    (task, index) =>
      `${index + 1}. ${formatCount(task.tokens)} · ` +
      escapeFeishuMarkdown(
        task.prompt.split("\n")[0]?.slice(0, HISTORY_SUMMARY_LENGTH) ?? "",
      ),
  );
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: `成本：${formatCount(summary.totalTokens)} tokens` },
    },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "成本" },
      subtitle: { tag: "plain_text", content: `${options.botName} · 本群` },
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      elements: [
        { tag: "markdown", content: lines.join("\n") },
        ...(originRows.length
          ? [
              { tag: "hr" },
              { tag: "markdown", content: `**按来源**\n${originRows.join("\n")}` },
            ]
          : []),
        ...(topRows.length
          ? [
              { tag: "hr" },
              { tag: "markdown", content: `**最贵的几件**\n${topRows.join("\n")}` },
            ]
          : []),
        {
          tag: "markdown",
          // 边界要说清楚：这不是「总共花了多少」，只是还留在历史里的那部分。
          content: `_只统计本群这台机器人还保留着的最近 ${options.capacity} 轮，不是全部开销。_`,
        },
      ],
    },
  };
}

// ─────────────────────────── 定时任务卡片 ───────────────────────────

function scheduleLine(schedule: Schedule): string {
  const state = schedule.enabled ? "启用" : "停用";
  const last = schedule.lastRunAt
    ? `上次 ${formatSessionTime(schedule.lastRunAt)} · ${
        schedule.lastStatus === "success"
          ? "成功"
          : schedule.lastStatus === "failed"
            ? "失败"
            : schedule.lastStatus === "waiting"
              ? "等待确认"
              : "跳过"
      }`
    : "尚未运行";
  return [
    `**${escapeFeishuMarkdown(schedule.name)}** _${state} · ${schedule.id}_`,
    `\`${escapeInlineCode(schedule.cron)}\` · ${last}`,
    schedule.lastError
      ? `⚠️ ${escapeFeishuMarkdown(schedule.lastError.slice(0, 120))}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export interface ScheduleListCardOptions {
  /** 按钮要带回作用域：卡片可以被转发，回调侧要拿它和实际位置对齐。 */
  botId: string;
  chatId: string;
  /** 正等待二次确认的那一条。删除不可撤销，先把按钮换成「确认删除」再动手。 */
  pendingDeleteId?: string;
  /** 点开二次确认的那个人。只有他能完成第二步。 */
  armedBy?: string;
}

function scheduleActionButton(
  options: ScheduleListCardOptions,
  scheduleId: string,
  label: string,
  action: string,
  type: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    size: "small",
    behaviors: [
      {
        type: "callback",
        value: {
          action,
          botId: options.botId,
          chatId: options.chatId,
          scheduleId,
          ...extra,
        },
      },
    ],
  };
}

/**
 * 每条定时任务后面跟一排操作按钮。删除走两步：第一次点只是把按钮换成
 * 「确认删除」，第二次才真删——定时任务删掉就没了，误触一次要重新描述一遍需求。
 */
function scheduleButtons(
  options: ScheduleListCardOptions,
  schedule: Schedule,
): Record<string, unknown> {
  const pendingDelete = options.pendingDeleteId === schedule.id;
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "8px",
    columns: [
      {
        tag: "column",
        width: "auto",
        elements: [
          // 目标状态写进按钮里，不能让回调侧「读当前值取反」：
          // 群里同时存在两张 /schedule 卡片是常态（发两次就有两张，
          // update_multi 只同步同一条消息的观众，不跨消息），
          // 旧卡上那个写着「停用」的按钮，取反之后干的是启用。
          scheduleActionButton(
            options,
            schedule.id,
            schedule.enabled ? "停用" : "启用",
            "schedule_toggle",
            "default",
            { enabled: !schedule.enabled },
          ),
        ],
      },
      {
        tag: "column",
        width: "auto",
        elements: [
          pendingDelete
            ? scheduleActionButton(
                options,
                schedule.id,
                "确认删除",
                "schedule_delete",
                "danger_filled",
                // armedBy：谁点的第一步，就只有谁能点第二步。
                // 卡片是群里共享的，不绑人的话甲点开确认、乙一下就替他删了，
                // 二次确认反而变成「对别人来说一点就删」。
                { confirmed: true, armedBy: options.armedBy ?? "" },
              )
            : scheduleActionButton(
                options,
                schedule.id,
                "删除",
                "schedule_delete",
                "danger_text",
              ),
        ],
      },
      ...(pendingDelete
        ? [
            {
              tag: "column",
              width: "auto",
              elements: [
                scheduleActionButton(
                  options,
                  schedule.id,
                  "取消",
                  "schedule_delete_cancel",
                  // 用 default 而不是 text：后者仓库里从没用过，
                  // 飞书卡片 2.0 认不认没验过，为一个次要按钮不值得赌整张卡渲染失败。
                  "default",
                ),
              ],
            },
          ]
        : []),
    ],
  };
}

export function buildScheduleListCard(
  schedules: Schedule[],
  options: ScheduleListCardOptions,
): CardJson {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: `定时任务：${schedules.length} 项` },
    },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "定时任务" },
      subtitle: { tag: "plain_text", content: `共 ${schedules.length} 项` },
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      elements: schedules.length
        ? schedules.flatMap((schedule, index) => [
            ...(index ? [{ tag: "hr" }] : []),
            { tag: "markdown", content: scheduleLine(schedule) },
            scheduleButtons(options, schedule),
          ])
        : [
            {
              tag: "markdown",
              content:
                "还没有定时任务。用一句话创建，例如：`/schedule 每天早上 9 点巡检一次服务端日志`",
            },
          ],
    },
  };
}
