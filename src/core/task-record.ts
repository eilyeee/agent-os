/**
 * 任务历史记录：模型、截断规则、滚动落盘与历史查询。
 * 一条记录 = 一轮 CLI 执行，只依赖内核类型，不认识任何消息平台。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { CliId } from "../cli/types.js";

/** 单条记录的落盘上限：一次超长粘贴或超长答案不该把整份 tasks.json 撑爆。 */
export const TASK_PROMPT_LIMIT = 2_000;
export const TASK_ANSWER_LIMIT = 4_000;
/**
 * 滚动保留条数。上限是整个文件的，不是每个群、每台 bot 的——
 * 单机 JSON 落盘下的取舍：一个高频群可能把低频群的记录挤出保留范围。
 */
export const TASK_RECORD_CAPACITY = 500;

/**
 * 一轮执行的结局。app 的 TurnOutcome 直接引用这里，
 * 避免出现「卡片上叫成功、历史里叫 done」这种第二套状态词汇。
 *
 * forwarded 与 waiting 必须是两个取值：两者都「没在本话题里给出最终答案」，但
 * forwarded 是这一轮确实做完了、只是结果流转了出去（定时任务已生效、活派给了队友），
 * waiting 是停在半路等人拍板（审批 / 澄清 / 产品方案卡还挂在群里）。
 * 压进同一个取值，任何按状态分档的视图都只能整档收下或整档排除，
 * 「只看做完的任务」就必然把等着人回答的任务算成已完成。
 */
export const TASK_RUN_STATUSES = [
  "success",
  "forwarded",
  "waiting",
  "failed",
  "cancelled",
] as const;
export type TaskRunStatus = (typeof TASK_RUN_STATUSES)[number];

/**
 * 只存在于旧记录里的状态：拆分之前，forwarded 和 waiting 共用 handoff 一个取值。
 * 记录里没有任何字段能把两者分开，所以不猜——原值保留，读得出来也看得见，
 * 只是不再计入「成功」档：让一条其实做完的老记录少出现在成功档里是可接受的损失，
 * 让一条还等着人拍板的老记录冒充已完成不是。
 * 新代码写不出这个值——TurnOutcome 用的是上面的 TaskRunStatus，写进来过不了类型检查。
 */
export const LEGACY_TASK_RUN_STATUSES = ["handoff"] as const;

/** 落盘记录里允许出现的全部状态 = 当前在产生的 + 历史遗留的。 */
export const TASK_RECORD_STATUSES = [
  ...TASK_RUN_STATUSES,
  ...LEGACY_TASK_RUN_STATUSES,
] as const;
export type TaskRecordStatus = (typeof TASK_RECORD_STATUSES)[number];

/** 这一轮是被谁触发的：话题内发起 / 定时触发 / 团队交接 / 澄清或审批后的续跑。 */
export const TASK_RUN_ORIGINS = [
  "user",
  "schedule",
  "handoff",
  "resume",
] as const;
export type TaskRunOrigin = (typeof TASK_RUN_ORIGINS)[number];

const TaskRecordSchema = z.object({
  id: z.string().min(1),
  /** 话题任务 id：同一话题里的多轮共享它。 */
  taskId: z.string().min(1),
  botId: z.string().min(1),
  chatId: z.string().min(1),
  threadId: z.string().min(1),
  /** Agent OS 自己的会话 id，和下面的 cliSessionId 不是一回事。 */
  sessionId: z.string().min(1),
  // 新增引擎时这里要一起放宽，否则该引擎的记录会在加载时被当成坏行丢掉。
  cliId: z.enum(["claude", "codex", "dsh"]),
  cliSessionId: z.string().min(1).optional(),
  workspaceDir: z.string().min(1),
  origin: z.enum(TASK_RUN_ORIGINS),
  /** 定时任务可能没有配 ownerOpenId，允许空串而不是让整条记录作废。 */
  ownerOpenId: z.string(),
  ownerName: z.string().optional(),
  title: z.string(),
  prompt: z.string(),
  /** 截断标记：详情视图要据此提示用户，别把截断误读成模型输出被砍。 */
  promptTruncated: z.boolean().default(false),
  // 老记录里的 handoff 要照样收下，否则一次语义变更就会把它们当坏行丢掉。
  status: z.enum(TASK_RECORD_STATUSES),
  answer: z.string().default(""),
  answerTruncated: z.boolean().default(false),
  failureReason: z.string().optional(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  durationMs: z.number().int().nonnegative(),
  toolCount: z.number().int().nonnegative(),
  completedToolCount: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  /**
   * 这一轮派生过哪些子 Agent。靠观察引擎事件流拿到，不靠引擎自报——
   * 真机上出现过报告说「等 tester 结论回来」而那一轮其实已经收尾了。
   * 老记录没有这个字段，读出来是 undefined：那是「不知道」，不是「没派过」。
   */
  subagents: z.array(z.string().min(1)).optional(),
  /** 上游瞬时故障重试了几次。没重试就不填。 */
  retries: z.number().int().positive().optional(),
  /**
   * 这一轮改过文件没有。只读的一轮没什么可验的。
   * 这里只存观察到的事实，「算不算验过」是展示层的判断——
   * 判断规则会变（比如以后加别的验证方式），事实不会。
   */
  editedFiles: z.boolean().optional(),
  /** 疑似在原地转时，重复的那个调用是什么。只是提示，不代表这一轮失败了。 */
  spinningOn: z.string().min(1).optional(),
  /** 任务卡消息 id：详情视图靠它把人指回当时那张卡片。 */
  cardMessageId: z.string().min(1).optional(),
});

export type TaskRecord = z.infer<typeof TaskRecordSchema>;

/** 追加一条记录需要的原始信息，id、截断标记和耗时由存储自己算。 */
export interface TaskRecordInput {
  taskId: string;
  botId: string;
  chatId: string;
  threadId: string;
  sessionId: string;
  cliId: CliId;
  cliSessionId?: string;
  workspaceDir: string;
  origin: TaskRunOrigin;
  ownerOpenId: string;
  ownerName?: string;
  title: string;
  prompt: string;
  status: TaskRunStatus;
  answer?: string;
  failureReason?: string;
  startedAt: string;
  finishedAt: string;
  toolCount: number;
  completedToolCount: number;
  turns?: number;
  totalTokens?: number;
  subagents?: string[];
  retries?: number;
  editedFiles?: boolean;
  spinningOn?: string;
  cardMessageId?: string;
}

function truncate(
  text: string,
  limit: number,
): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

export function buildTaskRecord(input: TaskRecordInput): TaskRecord {
  const prompt = truncate(input.prompt, TASK_PROMPT_LIMIT);
  const answer = truncate(input.answer ?? "", TASK_ANSWER_LIMIT);
  return {
    id: randomUUID().replaceAll("-", "").slice(0, 12),
    taskId: input.taskId,
    botId: input.botId,
    chatId: input.chatId,
    threadId: input.threadId,
    sessionId: input.sessionId,
    cliId: input.cliId,
    ...(input.cliSessionId ? { cliSessionId: input.cliSessionId } : {}),
    workspaceDir: input.workspaceDir,
    origin: input.origin,
    ownerOpenId: input.ownerOpenId,
    ...(input.ownerName ? { ownerName: input.ownerName } : {}),
    title: input.title,
    prompt: prompt.text,
    promptTruncated: prompt.truncated,
    status: input.status,
    answer: answer.text,
    answerTruncated: answer.truncated,
    ...(input.failureReason ? { failureReason: input.failureReason } : {}),
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    // 耗时在这里算，调用方各算各的迟早会算出两套口径。
    durationMs: Math.max(
      0,
      Date.parse(input.finishedAt) - Date.parse(input.startedAt),
    ),
    toolCount: input.toolCount,
    completedToolCount: input.completedToolCount,
    ...(input.turns !== undefined ? { turns: input.turns } : {}),
    ...(input.subagents?.length ? { subagents: input.subagents } : {}),
    ...(input.retries ? { retries: input.retries } : {}),
    ...(input.editedFiles ? { editedFiles: true } : {}),
    ...(input.spinningOn ? { spinningOn: input.spinningOn } : {}),
    ...(input.totalTokens !== undefined
      ? { totalTokens: input.totalTokens }
      : {}),
    ...(input.cardMessageId ? { cardMessageId: input.cardMessageId } : {}),
  };
}

/** 任务历史的滚动存储。文件按追加顺序保存，最新的一条在最后。 */
export class JsonTaskRecordStore {
  private records: TaskRecord[] = [];
  private writeQueue: Promise<void> = Promise.resolve();
  /** 变更串行化：并发追加时，回滚一次失败不能顺手撤销另一次成功的追加。 */
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly capacity = TASK_RECORD_CAPACITY,
  ) {}

  static async open(
    filePath: string,
    capacity = TASK_RECORD_CAPACITY,
  ): Promise<JsonTaskRecordStore> {
    const store = new JsonTaskRecordStore(filePath, capacity);
    await store.load();
    return store;
  }

  list(): TaskRecord[] {
    return [...this.records];
  }

  get size(): number {
    return this.records.length;
  }

  async append(input: TaskRecordInput): Promise<TaskRecord> {
    // 变更必须整体在队列内部做。放在队列外面等于没有串行：
    // persist() 序列化的是它真正执行那一刻的 this.records，而不是排队时的快照，
    // 「谁改了内存」和「谁把内存写下去」就脱钩了。
    const run = this.mutationQueue.then(async () => {
      const record = buildTaskRecord(input);
      const previous = this.records;
      this.records = [...previous, record].slice(-this.capacity);
      try {
        await this.persist();
      } catch (error) {
        // 还原整份快照，不能只按 id 删：满容量时 slice 已经挤掉了最老的一条，
        // 按 id 删补不回来，那条完全在保留范围内的记录会被永久删掉。
        this.records = previous;
        throw error;
      }
      return record;
    });
    // 队列本身不能因为一次失败就断掉，后面的记录还要接着排。
    this.mutationQueue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.records = [];
        return;
      }
      throw error;
    }

    let rows: unknown;
    try {
      rows = JSON.parse(content);
    } catch {
      await this.quarantine("不是合法 JSON");
      return;
    }
    if (!Array.isArray(rows)) {
      await this.quarantine("格式不是数组");
      return;
    }

    let records: TaskRecord[] = [];
    let needsCleanup = false;
    let legacyCount = 0;
    for (const row of rows) {
      const parsed = TaskRecordSchema.safeParse(row);
      if (!parsed.success) {
        // 坏行只跳过：一条被改坏的记录不该让整段历史消失。
        needsCleanup = true;
        continue;
      }
      // 迁移分支：状态语义拆分之前落盘的 handoff 原样收下，不改写成任何一个新取值。
      // 它同时代表「做完后流转」和「停下来等人」，改写等于替用户猜一半记录的结局。
      records.push(parsed.data);
    }
    if (records.length > this.capacity) {
      records = records.slice(-this.capacity);
      needsCleanup = true;
    }
    // 数在截断之后：超出保留范围的老记录已经不在内存里，报进去只会虚报一个用户查不到的数字。
    legacyCount = records.filter((record) => record.status === "handoff").length;
    if (legacyCount) {
      console.warn(
        `[历史] ${legacyCount} 条旧版 handoff 记录：当时这个状态混了「已交接」和「等人拍板」两种结局，只在「全部」档展示`,
      );
    }
    this.records = records;
    // 回写一次干净快照。历史是可观测性数据，写不动也不能让进程起不来。
    if (needsCleanup) {
      const dropped = rows.length - records.length;
      console.warn(`[历史] 跳过 ${dropped} 条无法解析或超出保留范围的任务记录`);
      await this.persist().catch((error) =>
        console.error("[历史] 回写干净快照失败:", (error as Error).message),
      );
    }
  }

  /**
   * 整份文件都读不成时（外部写坏、磁盘截断）挪到 .broken 再从空开始。
   * 直接覆盖会毁掉现场，直接抛错则会让一份可观测性数据挡住整个 Agent OS 启动。
   */
  private async quarantine(reason: string): Promise<void> {
    this.records = [];
    const brokenPath = `${this.filePath}.broken`;
    try {
      await rename(this.filePath, brokenPath);
      console.warn(
        `[历史] 任务记录文件${reason}，已挪到 ${brokenPath}，从空记录重新开始`,
      );
    } catch (error) {
      console.warn(
        `[历史] 任务记录文件${reason}，且无法备份：${(error as Error).message}`,
      );
    }
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.records, null, 2);
    const write = async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      // 先写临时文件再 rename，避免进程恰好在写到一半时留下半截 JSON。
      const tempPath = `${this.filePath}.tmp`;
      await writeFile(tempPath, `${snapshot}\n`, "utf8");
      await rename(tempPath, this.filePath);
    };
    // 并发对同一文件调 writeFile 并不安全，用队列让快照按顺序落盘。
    this.writeQueue = this.writeQueue.then(write, write);
    return this.writeQueue;
  }
}

// ─────────────────────────── 历史查询 ───────────────────────────

/** 交付小队里负责验证的两个子 Agent。少一个都不算验过。 */
const VERIFYING_SUBAGENTS = ["tester", "code-reviewer"] as const;

/**
 * 这一轮该不该被标成「未经验证」。
 *
 * 三个条件缺一不可：
 *   - 真的改过文件（只读的一轮没什么可验的，标了只是噪音）；
 *   - 引擎具备派子 Agent 的能力（Codex 不具备，拿同一把尺子量它，
 *     只会得到一片永远的「未验证」，那不是信息）；
 *   - 而它一个验证子 Agent 都没派。
 *
 * 注意这里判的是「没有证据表明验过」，不是「验得不好」。
 * 老记录没有 subagents 字段，读出来是 undefined——那是「不知道」，
 * 但对用户来说「不知道有没有验过」和「没验过」需要同样的警惕，所以一并标。
 */
export function isUnverifiedRun(
  record: Pick<TaskRecord, "editedFiles" | "subagents">,
  subagentCapable: boolean,
): boolean {
  if (!record.editedFiles || !subagentCapable) return false;
  const used = record.subagents ?? [];
  return !VERIFYING_SUBAGENTS.some((name) => used.includes(name));
}

/** 历史列表每页条数：飞书卡片一屏读得完的量。 */
export const TASK_HISTORY_PAGE_SIZE = 5;

/**
 * 列表卡上的四个筛选档。这里存的是筛选值本身，不是给人看的词——
 * 「全部 / 成功 / 失败 / 已停止」这类文案属于卡片层。
 */
export const TASK_HISTORY_FILTERS = [
  "all",
  "success",
  "failed",
  "cancelled",
] as const;
export type TaskHistoryFilter = (typeof TASK_HISTORY_FILTERS)[number];

/**
 * 筛选档 → 记录状态。「成功」= 这一轮真的做完了：自己跑完（success），
 * 或者做完之后把结果流转了出去（forwarded）——交接是完成之后的动作，
 * 单列一档只会让人在「成功」里找不到自己刚派出去的那条任务。
 *
 * waiting 与老记录 handoff 不属于任何一档，只在「全部」里出现：
 * 用户翻「成功」是在确认进度，一条还等着他拍板的任务躺在里面，
 * 等于告诉他这件事已经不用管了。
 */
const FILTER_STATUSES: Record<
  Exclude<TaskHistoryFilter, "all">,
  readonly TaskRecordStatus[]
> = {
  success: ["success", "forwarded"],
  failed: ["failed"],
  cancelled: ["cancelled"],
};

/**
 * 筛选值来自卡片按钮回调，属于外部输入：在边界上过一遍 Zod，认不出来的一律当
 * 「全部」，不是报错——一个手改过的按钮值不值得给用户一张失败卡片。
 * 收敛完才允许进 queryTaskRecords，内核那边只接已验证的 TaskHistoryFilter。
 */
export const TaskHistoryFilterSchema = z
  .enum(TASK_HISTORY_FILTERS)
  .catch("all");

export function parseTaskHistoryFilter(value: unknown): TaskHistoryFilter {
  return TaskHistoryFilterSchema.parse(value);
}

function matchesTaskHistoryFilter(
  status: TaskRecordStatus,
  filter: TaskHistoryFilter,
): boolean {
  return filter === "all" || FILTER_STATUSES[filter].includes(status);
}

/** 查询条件。作用域固定是「某个群 + 某台 bot」，跨话题。 */
export interface TaskHistoryQuery {
  chatId: string;
  botId: string;
  /** 不传就是「全部」。外部来的值先过 parseTaskHistoryFilter，这里不再收原始输入。 */
  filter?: TaskHistoryFilter;
  /** 从 1 开始。越界会收敛到有效页，而不是给一张空白卡片。 */
  page?: number;
  pageSize?: number;
}

export interface TaskHistoryPage {
  /** 本页的「事」，不是「轮」。 */
  tasks: TaskSummary[];
  /** 当前筛选下的条数，翻页按它算。 */
  total: number;
  /**
   * 不带筛选时本群本机器人的条数。卡片靠它把「筛选后为空」和「压根没有历史」
   * 分成两种文案——两者都是空列表，说错了用户会以为记录丢了。
   */
  scopeTotal: number;
  /** 实际生效的筛选：卡片和按钮回调都读这里，不读调用方请求的那个值。 */
  filter: TaskHistoryFilter;
  page: number;
  pageCount: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

/**
 * 纯函数查询：作用域过滤 → 状态筛选 → 倒序 → 分页。
 * 群 id 是硬约束：一台 bot 同时服务多个群，别的群的记录不能出现在这里。
 */
/**
 * 一件事：用户发起一次请求（或定时器触发一次），以及它之后的全部轮次。
 * 历史列表按这个单位展示——用户问的是「我让它删目录那件事怎么样了」，
 * 不是「第三轮执行的结局是什么」。
 */
export interface TaskSummary {
  taskId: string;
  /** 起头那一轮的指令。后面几轮是交接单、续跑提示，都不是用户说的话。 */
  prompt: string;
  promptTruncated: boolean;
  /** 当前状态 = 最后一轮的结局。在等人拍板就是 waiting，跑完就是 success。 */
  status: TaskRecordStatus;
  origin: TaskRunOrigin;
  ownerOpenId: string;
  ownerName?: string;
  startedAt: string;
  finishedAt: string;
  /**
   * 各轮耗时之和，**不是**首尾时间差。
   * 中间等人批审批可能隔了三小时，用首尾差会把「引擎跑了多久」
   * 说成「这件事拖了多久」——那是两回事，而人想知道的通常是前者。
   */
  durationMs: number;
  totalTokens?: number;
  /** 全部轮次，按发起时间正序。 */
  turns: TaskRecord[];
  /** 最后一轮的记录 id：点开详情默认看它。 */
  latestRecordId: string;
}

/**
 * 把一串轮次记录归成一件件事。按 taskId 分组，组内按时间正序。
 * 老记录的 taskId 是话题标识（拆分之前的语义），会把同话题的不同事情
 * 归成一堆——只影响 34 条历史测试数据，不值得为它写回填。
 */
export function groupIntoTasks(records: readonly TaskRecord[]): TaskSummary[] {
  const groups = new Map<string, TaskRecord[]>();
  for (const record of records) {
    const list = groups.get(record.taskId);
    if (list) list.push(record);
    else groups.set(record.taskId, [record]);
  }
  const summaries: TaskSummary[] = [];
  for (const [taskId, turns] of groups) {
    turns.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    const first = turns[0]!;
    const last = turns[turns.length - 1]!;
    const tokens = turns.reduce((sum, t) => sum + (t.totalTokens ?? 0), 0);
    summaries.push({
      taskId,
      prompt: first.prompt,
      promptTruncated: first.promptTruncated,
      status: last.status,
      origin: first.origin,
      ownerOpenId: first.ownerOpenId,
      ...(first.ownerName ? { ownerName: first.ownerName } : {}),
      startedAt: first.startedAt,
      finishedAt: last.finishedAt,
      durationMs: turns.reduce((sum, t) => sum + t.durationMs, 0),
      ...(tokens ? { totalTokens: tokens } : {}),
      turns,
      latestRecordId: last.id,
    });
  }
  return summaries;
}

export function queryTaskRecords(
  records: readonly TaskRecord[],
  query: TaskHistoryQuery,
): TaskHistoryPage {
  const pageSize = Number.isFinite(query.pageSize)
    ? Math.max(1, Math.floor(query.pageSize as number))
    : TASK_HISTORY_PAGE_SIZE;

  const scoped = records.filter(
    (record) => record.chatId === query.chatId && record.botId === query.botId,
  );
  const filter = query.filter ?? "all";
  // 先归成一件件事，再筛再分页：列表的单位是「事」不是「轮」。
  // 反过来做的话，一件三轮的事会占三行，翻页也按轮数算。
  const tasks = groupIntoTasks(scoped);
  const matched = tasks.filter((task) =>
    matchesTaskHistoryFilter(task.status, filter),
  );
  // 按起头时间倒序：最近发起的那件事排最前。
  matched.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

  const total = matched.length;
  // 没有记录时也算一页，空状态卡片才有「第 1/1 页」可显示。
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  // 页码来自卡片回调，属于外部输入：非法值和越界值都收敛到有效页。
  const requested = Number.isFinite(query.page)
    ? Math.floor(query.page as number)
    : 1;
  const page = Math.min(Math.max(1, requested), pageCount);
  const start = (page - 1) * pageSize;

  return {
    tasks: matched.slice(start, start + pageSize),
    total,
    scopeTotal: groupIntoTasks(scoped).length,
    filter,
    page,
    pageCount,
    hasPrevious: page > 1,
    hasNext: page < pageCount,
  };
}

/**
 * 一件事的全部轮次，按时间正序。作用域必须和列表、详情完全一致——
 * 少一道校验，别的群的轮次就会顺着 taskId 露出来。
 */
export function findTaskTurns(
  records: readonly TaskRecord[],
  query: { taskId: string; chatId: string; botId: string },
): TaskRecord[] {
  return records
    .filter(
      (record) =>
        record.taskId === query.taskId &&
        record.chatId === query.chatId &&
        record.botId === query.botId,
    )
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

/**
 * 一件事到目前为止花掉的 token。
 * 用已落盘的每轮最终统计相加——那是权威数字；
 * 引擎在跑的过程中只报每条消息的用量，带缓存时相加会重复计入前缀，虚高。
 */
export function spentOnTask(
  records: readonly TaskRecord[],
  taskId: string,
): number {
  let total = 0;
  for (const record of records) {
    if (record.taskId === taskId) total += record.totalTokens ?? 0;
  }
  return total;
}

export interface CostByOrigin {
  origin: TaskRunOrigin;
  turns: number;
  tokens: number;
  durationMs: number;
}

export interface CostSummary {
  /** 件数按「事」算。 */
  taskCount: number;
  /** 轮数按「轮」算：一件事可能跑很多轮，成本产生在轮上。 */
  turnCount: number;
  totalTokens: number;
  totalDurationMs: number;
  /** 按来源拆分，token 多的在前。 */
  byOrigin: CostByOrigin[];
  /** 最贵的几件事。 */
  topTasks: { prompt: string; tokens: number }[];
}

/**
 * 成本汇总。
 *
 * 来源拆分必须下沉到**轮**，不能按件算：一件用户发起的事，里面自动互审的
 * 那几轮 origin 是 handoff，而整件事的 origin 是 user。按件算的话，
 * 互审的开销会全部记到「用户发起」头上，那个最该被看见的数字就消失了。
 * 真实数据里它一度占到总量的四分之三。
 */
export function summarizeCost(
  tasks: readonly TaskSummary[],
  topCount = 3,
): CostSummary {
  const byOrigin = new Map<TaskRunOrigin, CostByOrigin>();
  let totalTokens = 0;
  let totalDurationMs = 0;
  let turnCount = 0;
  for (const task of tasks) {
    for (const turn of task.turns) {
      turnCount += 1;
      const tokens = turn.totalTokens ?? 0;
      totalTokens += tokens;
      totalDurationMs += turn.durationMs;
      const bucket = byOrigin.get(turn.origin) ?? {
        origin: turn.origin,
        turns: 0,
        tokens: 0,
        durationMs: 0,
      };
      bucket.turns += 1;
      bucket.tokens += tokens;
      bucket.durationMs += turn.durationMs;
      byOrigin.set(turn.origin, bucket);
    }
  }
  const topTasks = [...tasks]
    .map((task) => ({ prompt: task.prompt, tokens: task.totalTokens ?? 0 }))
    .filter((entry) => entry.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, topCount);
  return {
    taskCount: tasks.length,
    turnCount,
    totalTokens,
    totalDurationMs,
    byOrigin: [...byOrigin.values()].sort((a, b) => b.tokens - a.tokens),
    topTasks,
  };
}

/** 按 id 取详情时的查询条件。作用域必须和列表查询完全一致。 */
export interface TaskRecordLookup {
  id: string;
  chatId: string;
  botId: string;
}

/**
 * 取一条记录用于详情视图。三个条件缺一不可：
 * 记录 id 来自卡片按钮，是外部输入；卡片本身还能被转发到别的群、别的机器人面前。
 * 只按 id 查等于把「换一个 id 就能读到别的群」这条路留着。
 * 记录被滚动挤出保留范围时返回 undefined，由调用方给提示，不是抛错。
 */
export function findTaskRecord(
  records: readonly TaskRecord[],
  lookup: TaskRecordLookup,
): TaskRecord | undefined {
  if (!lookup.id || !lookup.chatId || !lookup.botId) return undefined;
  return records.find(
    (record) =>
      record.id === lookup.id &&
      record.chatId === lookup.chatId &&
      record.botId === lookup.botId,
  );
}
