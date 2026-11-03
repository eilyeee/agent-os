/**
 * 定时任务调度器。
 * 触发就是自动开一个新话题派活，之后完整复用普通任务的会话、卡片和协作链路——
 * 人工入口与自动化入口共享同一套任务内核，这一点不能有第二种实现。
 */
import { buildBotPrompt } from "../core/bot-registry.js";
import { parseCron } from "../core/cron.js";
import type { Schedule } from "../core/schedule.js";
import { newTaskId } from "../core/topic-task.js";
import { ensureAllowedWorkspace } from "../core/workspace.js";
import { isBotRequestAllowed } from "../core/access-control.js";
import { runCliTurn, taskAdmission, type TurnOutcome } from "./task-runner.js";
import type { AppRuntime } from "./runtime.js";

const TICK_MS = 30_000;

/**
 * 一轮执行的结局 → 定时任务卡片上「上次运行」的说法。
 *
 * 如实记录：CLI 失败时 runCliTurn 自己渲染失败卡并正常返回，
 * 一律记成功会让巡检类任务的失败被永久掩盖。
 * waiting 同理——它停在审批 / 澄清 / 产品方案上，人不点就永远不会有结论，
 * 记成 success 等于告诉用户这条定时任务已经跑通了，和历史那边犯同一个错。
 *
 * 写成穷举的 switch 而不是三元链：以后再往 TurnOutcome 里加取值，
 * 这里漏掉的话 TypeScript 会直接报错，而不是默默归进「成功」。
 */
export function scheduleRunStatus(
  outcome: TurnOutcome,
): NonNullable<Schedule["lastStatus"]> {
  switch (outcome) {
    case "failed":
      return "failed";
    case "cancelled":
      return "skipped";
    case "waiting":
      return "waiting";
    case "success":
    case "forwarded":
      return "success";
  }
}

export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  /** 每分钟只触发一次：30 秒一跳会在同一分钟内命中两次。 */
  private readonly lastFiredMinute = new Map<string, string>();
  /**
   * 正在执行的任务 id。
   * 定时任务每次触发都新开一个话题，会话准入拦不住重入——
   * 一条跑得比触发间隔还慢的任务会不断叠起新话题，只能在这里挡。
   */
  private readonly inFlight = new Set<string>();
  private running = false;

  constructor(private readonly runtime: AppRuntime) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        console.error("[定时] 调度失败:", (error as Error).message);
      });
    }, TICK_MS);
    this.timer.unref();
    console.log(`[定时] 调度器已启动，共 ${this.runtime.schedules.list().length} 项任务`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
      for (const schedule of this.runtime.schedules.list()) {
        if (!schedule.enabled) continue;
        if (this.lastFiredMinute.get(schedule.id) === minuteKey) continue;
        let matches = false;
        try {
          matches = parseCron(schedule.cron).matches(now);
        } catch (error) {
          console.error(
            `[定时] ${schedule.name} 的 cron 无法解析:`,
            (error as Error).message,
          );
          continue;
        }
        if (!matches) continue;
        this.lastFiredMinute.set(schedule.id, minuteKey);
        // 不 await 整轮执行：一个跑十分钟的任务不能把其他到点的任务全挡住。
        // running 标记只保护这一轮扫描，不保护任务本身。
        void this.fire(schedule).catch((error) => {
          console.error(`[定时] ${schedule.name} 触发异常:`, (error as Error).message);
        });
      }
    } finally {
      this.running = false;
    }
  }

  private async fire(schedule: Schedule): Promise<void> {
    // 同一条任务上一轮还没跑完就不要再起一轮，否则会话准入会直接把它挡回来。
    if (this.inFlight.has(schedule.id)) {
      console.warn(`[定时] ${schedule.name} 上一轮仍在执行，跳过本次触发`);
      await this.recordRun(schedule, "skipped", "上一轮仍在执行");
      return;
    }
    this.inFlight.add(schedule.id);
    try {
      await this.run(schedule);
    } finally {
      this.inFlight.delete(schedule.id);
    }
  }

  private async run(schedule: Schedule): Promise<void> {
    const botRuntime = this.runtime.botRuntimes.get(schedule.botId);
    if (!botRuntime) {
      console.warn(`[定时] ${schedule.name} 对应的 bot 未就绪: ${schedule.botId}`);
      await this.recordRun(schedule, "skipped", "对应的 bot 未就绪");
      return;
    }

    try {
      if (!isBotRequestAllowed(botRuntime.config, botRuntime.config.ownerOpenId ?? "", schedule.chatId)) {
        throw new Error("定时任务的负责人或聊天未获授权，请检查访问名单。");
      }
      const workspaceDir = schedule.workspaceDir ?? botRuntime.config.workspaceDir;
      await ensureAllowedWorkspace(workspaceDir, botRuntime.config);

      // 在群里发一条根消息，等于新开一个话题。
      const messageId = await botRuntime.bot.createThread(
        schedule.chatId,
        `⏰ 定时任务触发：${schedule.name}`,
      );
      if (!messageId) throw new Error("飞书没有返回新话题的 message_id");

      const address = {
        messageId,
        chatId: schedule.chatId,
        threadId: "",
        rootId: "",
      };
      const { session: resolvedSession } = await this.runtime.sessions.resolve(
        address,
        botRuntime.config.defaultCliId,
        botRuntime.config.id,
        workspaceDir,
      );
      // 给这个话题打上定时任务的标记。挂在会话上，后面无论跑多少轮
      // （审批拍板后续跑、澄清答完续跑、交接回来那轮）都带得上，
      // 删除那条定时任务时一个都不会漏。
      const session = await this.runtime.sessions.setScheduleId(resolvedSession.id, schedule.id);

      const admission = taskAdmission(this.runtime, session);
      if (!admission.ok) throw new Error(admission.reason);

      // 删除定时任务会连带中止正在跑的那一轮，凭的是 activeRuns 里那条带 scheduleId 的记录。
      // 而上面这几个 await（建目录、开话题、落会话）期间那条记录还不存在，
      // 这一段里被删掉的话没人拦得住，CLI 照样会起来跑完。所以启动前再确认一次它还在。
      // 这一句到 runCliTurn 之间不能插入 await：runCliTurn 是同步登记 activeRuns 的，
      // 中间一让出事件循环，就又开出一个中止不掉的窗口。
      if (!this.runtime.schedules.get(schedule.id)) {
        console.log(`[定时] ${schedule.name} 在本轮启动前已被删除，不再执行`);
        return;
      }

      const outcome: TurnOutcome = await runCliTurn({
        runtime: this.runtime,
        botRuntime,
        session,
        taskId: newTaskId(),
        replyToMessageId: messageId,
        replyInThread: true,
        // 定时任务由系统发起，通知回给这台 bot 眼里的负责人。
        ownerOpenId: botRuntime.config.ownerOpenId ?? "",
        decisionOwnerOpenId: botRuntime.config.ownerOpenId ?? "",
        origin: "schedule",
        prompt: buildBotPrompt(
          botRuntime.config,
          schedule.prompt,
          this.runtime.teamRegistry.contextFor(botRuntime.config.id),
          this.runtime.defaultProductDeliveryMode,
        ),
        taskText: schedule.prompt,
        cardTitle: `${this.runtime.getAdapter(session.cliId).displayName} · ${schedule.name}`,
      });
      await this.recordRun(
        schedule,
        scheduleRunStatus(outcome),
        outcome === "failed" ? "本轮执行失败，详见话题内的任务卡" : undefined,
      );
    } catch (error) {
      const message = (error as Error).message;
      console.error(`[定时] ${schedule.name} 触发失败:`, message);
      await this.recordRun(schedule, "failed", message);
    }
  }

  private async recordRun(
    schedule: Schedule,
    status: Schedule["lastStatus"],
    error?: string,
  ): Promise<void> {
    // 删除会连带中止正在跑的那一轮，收尾走到这里时这条任务往往已经不在存储里了。
    // 不先看一眼的话 update 只会抛「定时任务不存在」，在日志里报一次假警。
    if (!this.runtime.schedules.get(schedule.id)) return;
    try {
      await this.runtime.schedules.update(schedule.id, {
        lastRunAt: new Date().toISOString(),
        ...(status ? { lastStatus: status } : {}),
        ...(error ? { lastError: error } : { lastError: undefined }),
      });
    } catch (updateError) {
      console.error("[定时] 写入运行记录失败:", (updateError as Error).message);
    }
  }
}
