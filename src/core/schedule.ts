/** 定时任务的数据模型与持久化。schedules.json 支持运行时热更新。 */
import { mkdirSync, watch, watchFile, unwatchFile, type FSWatcher } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import { z } from "zod";
import type { ToolCallLike } from "./clarification.js";
import { isValidCron } from "./cron.js";

const RELOAD_DEBOUNCE_MS = 200; // 毫秒：一次原子保存可能产生多个文件事件。
const POLL_INTERVAL_MS = 200; // 毫秒：原生监听不可用时，单个配置文件仍保持秒内更新。

const CronSchema = z
  .string()
  .trim()
  .min(1)
  .refine(isValidCron, "cron 表达式无法解析（需要 5 个字段：分 时 日 月 周）");

const ScheduleSchema = z.object({
  id: z.string().min(1),
  /** 由哪台 bot 执行，决定角色、引擎和默认工作目录。 */
  botId: z.string().min(1),
  /** 触发时在哪个群开新话题。 */
  chatId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  cron: CronSchema,
  prompt: z.string().trim().min(1).max(4_000),
  workspaceDir: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  // 这个文件是设计给人手工编辑的，允许带时区偏移的 ISO 时间。
  // 默认的 z.iso.datetime() 只收 UTC 的 Z 后缀，手写 +08:00 会被静默丢掉。
  createdAt: z.iso.datetime({ offset: true }),
  lastRunAt: z.iso.datetime({ offset: true }).optional(),
  // waiting 是这次状态语义拆分补上的：一轮停在审批/澄清/产品方案上的执行，
  // 既不算成功也不算跳过。老的 schedules.json 里不会出现这个值，照常读得出来。
  lastStatus: z.enum(["success", "failed", "skipped", "waiting"]).optional(),
  lastError: z.string().optional(),
});

export type Schedule = z.infer<typeof ScheduleSchema>;

export const scheduleManageToolShape = {
  action: z.enum(["create", "update", "delete", "enable", "disable"]),
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(80).optional(),
  cron: CronSchema.optional(),
  prompt: z.string().trim().min(1).max(4_000).optional(),
  workspaceDir: z.string().trim().min(1).optional(),
};

export const ScheduleManageRequestSchema = z
  .object(scheduleManageToolShape)
  .strict()
  .superRefine((request, ctx) => {
    if (request.action === "create") {
      if (!request.name || !request.cron || !request.prompt) {
        ctx.addIssue({
          code: "custom",
          message: "创建定时任务需要同时提供 name、cron 和 prompt",
        });
      }
      return;
    }
    if (!request.id) {
      ctx.addIssue({
        code: "custom",
        message: `${request.action} 需要提供已存在的定时任务 id`,
      });
    }
  });

export type ScheduleManageRequest = z.infer<typeof ScheduleManageRequestSchema>;

export function findScheduleManageRequest(
  toolCalls: ToolCallLike[] | undefined,
): ScheduleManageRequest | undefined {
  for (let index = (toolCalls?.length ?? 0) - 1; index >= 0; index -= 1) {
    const call = toolCalls?.[index];
    if (call?.toolName !== "schedule_manage") continue;
    const parsed = ScheduleManageRequestSchema.safeParse(call.input);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

export class JsonScheduleStore {
  private schedules: Schedule[] = [];
  /** 解析失败的原始行：原样保留写回，绝不因为一个手写错误就把用户的任务删掉。 */
  private unparsedRows: unknown[] = [];
  private writeQueue: Promise<void> = Promise.resolve();
  /**
   * 变更串行化：否则回滚一次失败会顺手撤销另一次已经成功的改动。
   * 热更新的重载也排在这条队列上——它同样是整份替换内存状态的写者。
   */
  private mutationQueue: Promise<unknown> = Promise.resolve();
  /**
   * 磁盘上那份「内存已经对应过」的字节：自己刚写下去的，或者刚从磁盘读进来的。
   * watcher 只报「这个文件变了」，不报是谁改的、也不报改成了什么，
   * 只有拿内容比对才能判断这次事件要不要整份替换内存。
   *
   * 它回答的是「这份字节是不是已经在内存里了」，不是「是不是我写的」——
   * 只在自己写盘时更新的话，人手工改一次再改回来（磁盘逐字节回到自己写过的那份），
   * 第二次编辑会被当成自我写盘吞掉，内存还留着中间那一版，下次落盘再覆盖回磁盘。
   */
  private syncedContent: string | undefined;
  private watcher: FSWatcher | undefined;
  private pollListener: (() => void) | undefined;
  private reloadTimer: NodeJS.Timeout | undefined;
  private onChange: (() => void) | undefined;

  constructor(private readonly filePath: string) {}

  static async open(filePath: string): Promise<JsonScheduleStore> {
    const store = new JsonScheduleStore(filePath);
    await store.reload();
    return store;
  }

  list(): Schedule[] {
    return [...this.schedules];
  }

  /** 只按 bot 过滤，跨所有群。仅用于「这台 bot 有没有定时任务」这类全局判断。 */
  listForBot(botId: string): Schedule[] {
    return this.schedules.filter((schedule) => schedule.botId === botId);
  }

  /**
   * 给人看的列表一律用这个：群 id 是硬约束。
   * 一台 bot 同时服务多个群，A 群不该看到 B 群的定时任务——
   * 任务名和执行内容都会连带露出去。/history 早就是这个规矩，这里补齐。
   */
  listForScope(botId: string, chatId: string): Schedule[] {
    return this.schedules.filter(
      (schedule) => schedule.botId === botId && schedule.chatId === chatId,
    );
  }

  get(id: string): Schedule | undefined {
    return this.schedules.find((schedule) => schedule.id === id);
  }

  async create(
    input: Omit<Schedule, "id" | "createdAt" | "enabled"> & { enabled?: boolean },
  ): Promise<Schedule> {
    return this.mutate(() => {
      const schedule: Schedule = {
        ...input,
        id: randomUUID().replaceAll("-", "").slice(0, 12),
        enabled: input.enabled ?? true,
        createdAt: new Date().toISOString(),
      };
      this.schedules = [...this.schedules, schedule];
      return schedule;
    });
  }

  async update(id: string, patch: Partial<Schedule>): Promise<Schedule> {
    return this.mutate(() => {
      const current = this.get(id);
      if (!current) throw new Error(`定时任务不存在: ${id}`);
      const updated: Schedule = { ...current, ...patch, id: current.id };
      this.schedules = this.schedules.map((schedule) =>
        schedule.id === id ? updated : schedule,
      );
      return updated;
    });
  }

  async remove(id: string): Promise<Schedule> {
    return this.mutate(() => {
      const current = this.get(id);
      if (!current) throw new Error(`定时任务不存在: ${id}`);
      this.schedules = this.schedules.filter((schedule) => schedule.id !== id);
      return current;
    });
  }

  /**
   * 串行执行一次变更：先改内存再落盘，失败则把内存恢复到「本次变更之前」。
   * 队列保证同一时刻只有一次变更在飞，所以恢复整份快照不会误伤别人的改动。
   */
  private async mutate<T>(apply: () => T): Promise<T> {
    return this.enqueue(async () => {
      const previous = this.schedules;
      const result = apply();
      try {
        await this.persist();
      } catch (error) {
        // 回滚内存值：磁盘和内存不能出现两个版本。
        this.schedules = previous;
        throw error;
      }
      return result;
    });
  }

  /**
   * 排进同一条队列。凡是会整份替换 `schedules` 的动作都必须走这里。
   * 变更和热更新各自都有 await 断点，不排队的话后落地的那个会拿着过期快照
   * 覆盖另一个刚做完的改动——删掉的任务复活、刚改的字段被写回旧值。
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(task);
    // 队列本身不能因为一次失败就断掉，后续变更还要继续排。
    this.mutationQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * 外部编辑 schedules.json 后自动重载。
   *
   * 监听的是所在目录而不是文件本身，有两个理由：
   * - 文件还不存在时也能监听，外部第一次创建就能收到（watch 文件会直接抛 ENOENT）；
   * - tmp + rename 会换掉文件 inode，绑在文件上的 watcher 随之失效，
   *   而目录 inode 不变，不需要每次写盘后重挂。
   */
  watchFile(onChange?: () => void): void {
    if (onChange) this.onChange = onChange;
    if (this.watcher || this.pollListener) return;
    const directory = dirname(this.filePath);
    const target = basename(this.filePath);
    const reload = () => {
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => {
        void this.enqueue(() => this.readFromDisk())
          .then((replaced) => {
            if (replaced) this.onChange?.();
          })
          .catch((error) => {
            console.error("[定时] 热更新失败:", (error as Error).message);
          });
      }, RELOAD_DEBOUNCE_MS);
      this.reloadTimer.unref();
    };
    const fallback = (error: unknown) => {
      // fs.watch 的资源错误也会异步发出，只包 try/catch 仍会带走整个进程。
      this.watcher?.close();
      this.watcher = undefined;
      if (this.pollListener) return;
      console.warn("[定时] 原生监听不可用，改用轮询:", (error as Error).message);
      this.pollListener = reload;
      watchFile(this.filePath, { persistent: false, interval: POLL_INTERVAL_MS }, this.pollListener);
    };
    try {
      mkdirSync(directory, { recursive: true });
      this.watcher = watch(directory, (_event, filename) => {
        if (filename && basename(filename) !== target) return;
        reload();
      });
      const watcher = this.watcher;
      watcher.on("error", (error) => {
        // close 后迟到的 error 不能重新挂起轮询。
        if (this.watcher === watcher) fallback(error);
      });
      this.watcher.unref();
    } catch (error) {
      fallback(error);
    }
  }

  close(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.watcher?.close();
    this.watcher = undefined;
    if (this.pollListener) unwatchFile(this.filePath, this.pollListener);
    this.pollListener = undefined;
  }

  async reload(): Promise<void> {
    await this.enqueue(() => this.readFromDisk());
  }

  /**
   * 把磁盘内容读进内存，返回内存是否真的被替换过。
   * 只允许在队列内部调用：它整份替换 `schedules`，和一次变更是同一类写者。
   */
  private async readFromDisk(): Promise<boolean> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const hadRows = this.schedules.length > 0 || this.unparsedRows.length > 0;
        this.schedules = [];
        this.unparsedRows = [];
        // 文件没了，先前那份内容不再代表磁盘上的任何东西。
        this.syncedContent = undefined;
        // 原来有任务、现在被删空了，这就是一次真实变更，调度器得跟着停掉。
        return hadRows;
      }
      throw error;
    }
    // 内存已经是这份内容了，再整份替换一次只会平白制造一次自我重载——
    // 自己写盘同样会触发 watcher，每次 create / update / remove 之后都跟一次。
    if (content === this.syncedContent) return false;
    let rows: unknown;
    try {
      rows = JSON.parse(content);
    } catch {
      throw new Error(`定时任务文件不是合法 JSON: ${this.filePath}`);
    }
    if (!Array.isArray(rows)) {
      throw new Error(`定时任务文件格式错误: ${this.filePath}`);
    }
    const parsed: Schedule[] = [];
    const unparsed: unknown[] = [];
    for (const row of rows) {
      const result = ScheduleSchema.safeParse(row);
      if (result.success) {
        parsed.push(result.data);
        continue;
      }
      // 坏记录只跳过并报警，不能让一条错配置停掉整个调度器；
      // 但也要原样留着，下一次写盘不能把用户手写的任务抹掉。
      // 报清楚是哪一条、哪个字段：手写配置出错时这条日志是唯一的线索。
      const id =
        typeof (row as { id?: unknown })?.id === "string"
          ? (row as { id: string }).id
          : "(缺少 id)";
      const fields = result.error.issues
        .map((issue) => `${issue.path.join(".") || "(根)"}: ${issue.message}`)
        .join("；");
      console.warn(
        `[定时] 跳过无法解析的任务 ${id}（已原样保留在文件里）：${fields}`,
      );
      unparsed.push(row);
    }
    this.schedules = parsed;
    this.unparsedRows = unparsed;
    // 外部编辑同样要记：内存现在对应的是磁盘上这份字节，不是自己上次写的那份。
    this.syncedContent = content;
    return true;
  }

  private persist(): Promise<void> {
    // 解析失败的行一起写回去，它们只是不参与调度，不该被删除。
    const snapshot = JSON.stringify(
      [...this.schedules, ...this.unparsedRows],
      null,
      2,
    );
    const content = `${snapshot}\n`;
    const write = async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.tmp`;
      await writeFile(tempPath, content, "utf8");
      await rename(tempPath, this.filePath);
      // 记在 rename 之后：写失败时磁盘还是上一份内容，这个指纹也就还对得上。
      this.syncedContent = content;
    };
    this.writeQueue = this.writeQueue.then(write, write);
    return this.writeQueue;
  }
}
