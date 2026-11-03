/** 进程内共享的运行时状态。消息回调、卡片回调和后台任务都从这里取。 */
import type { CliAdapter, CliId } from "../cli/types.js";
import type { Bot, BotIdentity } from "../im/lark.js";
import type { ActiveRun } from "../core/task-abort.js";
import type {
  BotConfig,
  ProductDeliveryMode,
} from "../core/bot-registry.js";
import type { CollaborationInbox } from "../core/collaboration.js";
import type { ClarificationFlowStore } from "../core/clarification.js";
import type { ProductSpecFlowStore } from "../core/product-spec.js";
import type { ApprovalFlowStore } from "../core/approval.js";
import type { JsonScheduleStore } from "../core/schedule.js";
import type { SessionManager } from "../core/session-manager.js";
import type { JsonTaskRecordStore } from "../core/task-record.js";
import type { TeamRegistry } from "../core/team-registry.js";

export interface BotRuntime {
  config: BotConfig;
  bot: Bot;
  identity: BotIdentity;
}

export interface AppRuntime {
  sessions: SessionManager;
  /**
   * 引擎查找。默认就是 cli/registry，和 sessions、schedules 一样作为协作者注入，
   * 这样 app/ 不必硬绑某一份注册表。
   */
  getAdapter: (id: CliId) => CliAdapter;
  teamRegistry: TeamRegistry;
  defaultProductDeliveryMode: ProductDeliveryMode;
  /** 正在运行的任务，停止按钮和 /close 都查这里。 */
  activeRuns: Map<string, ActiveRun>;
  /** 上一轮拿到的模型窗口，下一轮卡片用它算占用百分比。 */
  contextWindows: Map<string, number>;
  botRuntimes: Map<string, BotRuntime>;
  processedCollaborationTurns: Set<string>;
  collaborationInbox: CollaborationInbox;
  clarificationFlows: ClarificationFlowStore;
  productSpecFlows: ProductSpecFlowStore;
  approvalFlows: ApprovalFlowStore;
  schedules: JsonScheduleStore;
  /** 任务历史：每一轮 CLI 执行收尾时追加一条。 */
  taskRecords: JsonTaskRecordStore;
}
