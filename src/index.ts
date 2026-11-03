/**
 * Agent OS 入口：加载配置、启动全部 bot、接住消息与事件。
 * 这里只做接线和准入判断，任务本身交给 app/task-runner。
 */
import "dotenv/config";
import { join, resolve } from "node:path";
import {
  startBot,
  type Bot,
  type IncomingDocumentComment,
} from "./im/lark.js";
import { getCliAdapter, listCliAdapters } from "./cli/registry.js";
import { setApplicationCredentialNames } from "./cli/spawn-cli.js";
import { loadAgentOsConfig, type BotConfig } from "./core/bot-registry.js";
import { ApprovalFlowStore } from "./core/approval.js";
import { ClarificationFlowStore } from "./core/clarification.js";
import { CollaborationInbox } from "./core/collaboration.js";
import { JsonProductSpecFlowStore } from "./core/product-spec-store.js";
import { JsonScheduleStore } from "./core/schedule.js";
import { SessionManager } from "./core/session-manager.js";
import { JsonSessionStore } from "./core/session-store.js";
import { JsonTaskRecordStore } from "./core/task-record.js";
import type { ActiveRun } from "./core/task-abort.js";
import { TeamRegistry } from "./core/team-registry.js";
import { ensureAllowedWorkspace } from "./core/workspace.js";
import { isChatAllowed } from "./core/access-control.js";
import { createCardActionHandler } from "./app/card-action-handler.js";
import { canReviewProductComment, runProductDocumentComment } from "./app/product-comment-runner.js";
import { Scheduler } from "./app/scheduler.js";
import { createMessageHandler } from "./app/message-router.js";
import type { AppRuntime, BotRuntime } from "./app/runtime.js";

const MAX_REMEMBERED_COMMENT_EVENTS = 1_000;

/** 启动期的错误是运维在读，给一句能直接照做的话，不要甩栈。 */
function exitWithStartupError(error: unknown): never {
  console.error(`\nAgent OS 启动失败：${(error as Error).message}\n`);
  process.exit(1);
}

const botConfigPath = resolve(
  process.env.BOTS_CONFIG ?? join("config", "bots.json"),
);
const agentOsConfig = await loadAgentOsConfig(botConfigPath).catch(
  exitWithStartupError,
);
const botConfigs = agentOsConfig.bots;
setApplicationCredentialNames(agentOsConfig.credentialEnvNames);
const teamRegistry = new TeamRegistry(agentOsConfig.teamLeaderId, botConfigs);

await Promise.all(
  botConfigs.map((config) =>
    // 保留真实原因：「不是文件夹」和「不存在」是两种不同的排查方向。
    ensureAllowedWorkspace(config.workspaceDir, config).catch((error) =>
      exitWithStartupError(
        new Error(
          `bot ${config.id} 的工作目录有问题：${(error as Error).message}\n请检查 ${botConfigPath} 里的 workspace 配置。`,
        ),
      ),
    ),
  ),
);
for (const missing of await teamRegistry.findMissingSkills()) {
  console.warn(
    `[Skill] bot=${missing.botId} 找不到 $${missing.skill}，请安装到工作区的 .agents/skills 或 .claude/skills`,
  );
}

const defaultWorkspaces = Object.fromEntries(
  botConfigs.map((config) => [config.id, config.workspaceDir]),
);
const sessions = await SessionManager.open({
  store: new JsonSessionStore(
    join("data", "sessions.json"),
    botConfigs[0]?.id,
    defaultWorkspaces,
  ),
});

const runtime: AppRuntime = {
  sessions,
  getAdapter: getCliAdapter,
  teamRegistry,
  defaultProductDeliveryMode: agentOsConfig.defaultProductDeliveryMode,
  activeRuns: new Map<string, ActiveRun>(),
  contextWindows: new Map<string, number>(),
  botRuntimes: new Map<string, BotRuntime>(),
  processedCollaborationTurns: new Set<string>(),
  collaborationInbox: new CollaborationInbox(),
  clarificationFlows: new ClarificationFlowStore(),
  productSpecFlows: new JsonProductSpecFlowStore(
    join("data", "product-spec-flows.json"),
  ),
  approvalFlows: new ApprovalFlowStore(),
  schedules: await JsonScheduleStore.open(join("data", "schedules.json")),
  taskRecords: await JsonTaskRecordStore.open(join("data", "tasks.json")),
};

console.log("Agent OS 启动，正在建立飞书长连接…");
console.log(
  `[配置] 已注册 ${botConfigs.length} 个 bot，Team Leader=${teamRegistry.leaderBotId}，已恢复 ${sessions.size} 个会话，${runtime.taskRecords.size} 条任务记录`,
);
for (const adapter of listCliAdapters()) {
  console.log(`[CLI] id=${adapter.id} command=${adapter.command}`);
}
for (const config of botConfigs) {
  if (!config.ownerOpenId && !config.allowedUserOpenIds?.length) {
    console.warn(`[准入] bot=${config.id} 未配置负责人或人员名单，所有人发起的请求将被拒绝。请配置 ownerOpenId 或 allowedUserOpenIds。`);
  }
  console.log(
    `[Bot ${config.id.toUpperCase()}] default_cli=${config.defaultCliId} workspace=${config.workspaceDir}`,
  );
}

// ─────────────────── 云文档评论调度 ───────────────────

const processedCommentEvents = new Set<string>();
const commentQueues = new Map<string, Promise<void>>();

function rememberCommentEvent(eventKey: string): void {
  processedCommentEvents.add(eventKey);
  if (processedCommentEvents.size <= MAX_REMEMBERED_COMMENT_EVENTS) return;
  const oldest = processedCommentEvents.values().next().value;
  if (oldest) processedCommentEvents.delete(oldest);
}

function scheduleDocumentComment(
  config: BotConfig,
  bot: Bot,
  comment: IncomingDocumentComment,
): void {
  // 只处理明确 @了本 bot、且能关联到待确认云文档的评论。
  if (!comment.mentionedBot) return;
  const flow = runtime.productSpecFlows.findPendingByDocument(
    config.id,
    comment.fileToken,
  );
  if (!flow) return;
  if (!canReviewProductComment(config, flow, comment) || !isChatAllowed(config, runtime.sessions.get(flow.sessionId)?.chatId ?? "")) {
    console.warn(`[准入] 已拒绝文档评论 bot=${config.id} sender=${comment.senderOpenId}`);
    return;
  }

  const eventKey =
    comment.eventId ||
    [comment.fileToken, comment.commentId, comment.replyId].join(":");
  if (processedCommentEvents.has(eventKey)) return;
  rememberCommentEvent(eventKey);

  const working = bot
    .setDocumentCommentWorking(comment, true)
    .then(() => true)
    .catch((error) => {
      console.warn("[评论] 添加处理中表情失败，继续执行:", (error as Error).message);
      return false;
    });

  // 同一会话的多条评论串行执行，避免两个任务同时续接同一个 CLI 会话。
  const previous = commentQueues.get(flow.sessionId) ?? Promise.resolve();
  const queued = Promise.all([previous.catch(() => undefined), working]).then(
    async ([, reactionAdded]) => {
      try {
        await runProductDocumentComment({ runtime, bot, flow, comment });
      } finally {
        if (reactionAdded) {
          await bot
            .setDocumentCommentWorking(comment, false)
            .catch((error) =>
              console.warn("[评论] 移除处理中表情失败:", (error as Error).message),
            );
        }
      }
    },
  );
  commentQueues.set(flow.sessionId, queued);

  void queued
    .catch((error) =>
      bot.replyToDocumentComment(
        comment,
        `这条评论暂时没有处理完成：${(error as Error).message}`,
      ),
    )
    .catch((error) =>
      console.error("[评论] 回写失败:", (error as Error).message),
    )
    .finally(() => {
      if (commentQueues.get(flow.sessionId) === queued) {
        commentQueues.delete(flow.sessionId);
      }
    });
}

// ─────────────────── 启动一台 bot ───────────────────

async function startConfiguredBot(config: BotConfig): Promise<void> {
  const startedBot = startBot({
    appId: config.appId,
    appSecret: config.appSecret,

    onCardAction: createCardActionHandler({ runtime, config }),

    ...(config.skills.includes("lark-drive")
      ? {
          onDocumentComment: async (comment, bot) => {
            scheduleDocumentComment(config, bot, comment);
          },
        }
      : {}),

    onMessage: createMessageHandler({ runtime, config }),
  });

  const identity = await startedBot.getIdentity();
  runtime.botRuntimes.set(config.id, {
    config,
    bot: startedBot,
    identity,
  });
  if (config.skills.includes("lark-drive")) {
    await startedBot.subscribeToDocumentComments();
  }
  console.log(
    `[Bot ${config.id.toUpperCase()}] 已连接 name=${identity.name} open_id=${identity.openId}`,
  );
}

// 任何一台连不上都直接失败：半启动的团队会让派活悄悄丢在不存在的成员上。
await Promise.all(botConfigs.map(startConfiguredBot)).catch(exitWithStartupError);

for (const config of botConfigs) {
  if (config.ownerOpenId) continue;
  if (!runtime.schedules.listForBot(config.id).length) continue;
  console.warn(
    `[定时] bot ${config.id} 没有配置 ownerOpenId，它触发的审批卡将没有人可以拍板。`,
  );
}

runtime.schedules.watchFile(() => {
  console.log(`[定时] 已热更新，共 ${runtime.schedules.list().length} 项任务`);
});
const scheduler = new Scheduler(runtime);
scheduler.start();

/**
 * 引擎是 detached 启动的（取消时要杀整棵进程树），代价是它不随 Agent OS 一起退出。
 * 关闭时必须主动中止所有运行中的任务，否则会留下没人看管、却还在改文件的引擎。
 */
function shutdown(signal: string): void {
  console.log(`\n收到 ${signal}，正在停止…`);
  scheduler.stop();
  runtime.schedules.close();
  for (const [sessionId, run] of runtime.activeRuns) {
    run.cancelMode = "close";
    run.controller.abort();
    console.log(`[关闭] 已中止运行中的任务 session=${sessionId}`);
  }
  // 留一点时间让 abort 把进程组杀干净再退出。
  setTimeout(() => process.exit(0), 1_500).unref();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => shutdown(signal));
}
