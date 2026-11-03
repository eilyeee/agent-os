/** 正在运行的任务清单，以及停止任务时的权限与状态收敛。 */

export interface ActiveRun {
  controller: AbortController;
  /** 只有任务发起人可以停止它。 */
  ownerOpenId: string;
  /** 卡片按钮只停本轮执行，/close 连会话一起关，底层用同一个停止信号。 */
  cancelMode?: "stop" | "close";
  /**
   * 这一轮由哪条定时任务触发。删掉那条任务时要顺着它找回本轮并中止——
   * 只摘掉存储记录的话，引擎还会按这条已经不存在的任务继续改用户的文件。
   */
  scheduleId?: string;
}

export type AbortTaskOutcome =
  | "stopped"
  | "already_stopping"
  | "not_found"
  | "forbidden";

export function requestTaskAbort(
  activeRuns: Map<string, ActiveRun>,
  sessionId: string,
  operatorOpenId: string,
): AbortTaskOutcome {
  const active = activeRuns.get(sessionId);
  // 任务结束后记录已被删除，点旧卡片只会得到提示，不会影响下一轮任务。
  if (!active) return "not_found";
  if (operatorOpenId !== active.ownerOpenId) return "forbidden";
  if (active.controller.signal.aborted) return "already_stopping";
  active.cancelMode = "stop";
  active.controller.abort();
  return "stopped";
}

export type ScheduleAbortOutcome = "stopped" | "already_stopping" | "not_running";

/**
 * 定时任务被删除时，中止它正在跑的那一轮。
 *
 * 这里**不做归属校验**，和「停止」按钮走的 requestTaskAbort 不是一回事：
 * 那边是甲要停乙的任务，得先证明自己是发起人；这里是这一轮的发起者本身
 * （那条定时任务）被撤销了，没有任何人还想要它的结果。
 * 真拿归属去卡还会卡错人——定时轮的归属人是 bot 配置里的 ownerOpenId，
 * 群里点删除的往往不是他，而这个字段是可选的，没配时它是空串，那就谁都停不掉。
 * 这一刀的准入在删除那一侧：同 bot、同群、两步确认、且只有点开确认的人能落。
 *
 * 遍历全部而不是按 id 直取：同一条定时任务同时只该有一轮在飞（调度器的 inFlight 挡着），
 * 但「应该只有一个」不该由这里来赌——删除的语义是全停掉，不是停掉碰见的第一个。
 */
export function abortScheduleRuns(
  activeRuns: Map<string, ActiveRun>,
  scheduleId: string,
): ScheduleAbortOutcome {
  let stopped = 0;
  let alreadyStopping = 0;
  for (const run of activeRuns.values()) {
    if (run.scheduleId !== scheduleId) continue;
    if (run.controller.signal.aborted) {
      alreadyStopping += 1;
      continue;
    }
    run.cancelMode = "stop";
    run.controller.abort();
    stopped += 1;
  }
  if (stopped > 0) return "stopped";
  if (alreadyStopping > 0) return "already_stopping";
  return "not_running";
}
