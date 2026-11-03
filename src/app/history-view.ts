/** /history 列表卡与详情卡的取数与渲染，命令、翻页、筛选和详情回调共用一份。 */
import {
  buildHistoryCard,
  buildHistoryDetailCard,
  type CardJson,
} from "../im/card.js";
import {
  findTaskRecord,
  findTaskTurns,
  isUnverifiedRun,
  queryTaskRecords,
  type TaskHistoryFilter,
  type TaskHistoryPage,
  type TaskRecord,
} from "../core/task-record.js";
import type { AppRuntime } from "./runtime.js";

/**
 * 查询和渲染必须一次完成：卡片上的按钮会把作用域、页码和筛选原样带回来，
 * 一旦「查的是哪个群」和「按钮里写的是哪个群」分头维护，翻一页就可能翻到别人的记录上。
 */
export function renderHistoryPage(options: {
  runtime: AppRuntime;
  botId: string;
  chatId: string;
  /** 不传就是第一页；越界由 queryTaskRecords 收敛。 */
  page?: number;
  /** 不传就是「全部」；调用方负责先把回调里的原始值过 parseTaskHistoryFilter。 */
  filter?: TaskHistoryFilter;
}): { card: CardJson; page: TaskHistoryPage } {
  const { runtime, botId, chatId } = options;
  const page = queryTaskRecords(runtime.taskRecords.list(), {
    chatId,
    botId,
    filter: options.filter,
    ...(options.page !== undefined ? { page: options.page } : {}),
  });
  return {
    page,
    // 卡片读的是查询结果里那个已经收敛过的筛选值，不是请求里的原值：
    // 两边分头维护的话，非法筛选会渲染出「筛选：失败」却列着全部记录。
    card: buildHistoryCard({
      botName: runtime.botRuntimes.get(botId)?.identity.name ?? botId,
      botId,
      chatId,
      page,
    }),
  };
}

/**
 * 单条记录的详情。取数和列表走同一套作用域（本群 + 本机器人），
 * 记录已被滚动挤出保留范围时返回 undefined，由调用方给 toast——
 * 这是正常结局，不是错误，卡片该原样留在用户眼前。
 */
export function renderHistoryDetail(options: {
  runtime: AppRuntime;
  botId: string;
  chatId: string;
  recordId: string;
  /** 点开详情前所在的页码与筛选，只是原样转交给「返回列表」按钮。 */
  page: number;
  filter: TaskHistoryFilter;
}): { card: CardJson; record: TaskRecord } | undefined {
  const { runtime, botId, chatId } = options;
  const record = findTaskRecord(runtime.taskRecords.list(), {
    id: options.recordId,
    chatId,
    botId,
  });
  if (!record) return undefined;
  // 引擎能力只有 cli/ 知道，判断规则只有 core/ 知道，
  // 把两者凑到一起是 app/ 的活——卡片层只负责把结论画出来。
  const unverified = isUnverifiedRun(
    record,
    runtime.getAdapter(record.cliId).capabilities.subagents,
  );
  // 这件事的全部轮次：列表按「事」列之后，早期轮次只能从时间线上点进去。
  const turns = findTaskTurns(runtime.taskRecords.list(), {
    taskId: record.taskId,
    chatId,
    botId,
  });
  return {
    record,
    card: buildHistoryDetailCard({
      ...(unverified ? { unverified: true } : {}),
      ...(turns.length > 1 ? { turns } : {}),
      botName: runtime.botRuntimes.get(botId)?.identity.name ?? botId,
      botId,
      chatId,
      record,
      page: options.page,
      filter: options.filter,
    }),
  };
}
