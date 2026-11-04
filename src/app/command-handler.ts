/** 斜杠命令集中处理。返回 handled 表示已经回复完成，continue 表示继续进入任务主线。 */
import {
  buildCostCard,
  buildResumeCard,
  buildScheduleListCard,
  buildSessionNoticeCard,
  buildTeamCard,
} from "../im/card.js";
import type { Bot, IncomingMessage } from "../im/lark.js";
import {
  filterResumableSessions,
  listNativeCliSessions,
} from "../cli/native-sessions.js";
import type { CliAdapter } from "../cli/types.js";
import type { BotConfig } from "../core/bot-registry.js";
import { isBotRequestAllowed } from "../core/access-control.js";
import type { CliRequest, SlashCommand } from "../core/command-parser.js";
import type { Session } from "../core/session-manager.js";
import {
  ensureAllowedWorkspace,
  resolveWorkspacePath,
} from "../core/workspace.js";
import {
  TASK_RECORD_CAPACITY,
  groupIntoTasks,
  summarizeCost,
} from "../core/task-record.js";
import { helpLines } from "./commands.js";
import { renderHistoryPage } from "./history-view.js";
import { formatSessionStatus } from "./session-view.js";
import type { AppRuntime } from "./runtime.js";

export type CommandOutcome = "handled" | "continue";

function bindingChanged(runtime: AppRuntime, session: Session): boolean {
  const current = runtime.sessions.get(session.id);
  return !current || current.status === "closed" || current.status === "active" || runtime.activeRuns.has(session.id)
    || runtime.sessions.isUpdating(session.id)
    || current.workspaceDir !== session.workspaceDir || current.cliSessionId !== session.cliSessionId;
}

export async function handleSessionCommand(options: {
  runtime: AppRuntime;
  config: BotConfig;
  msg: IncomingMessage;
  bot: Bot;
  session: Session;
  cliAdapter: CliAdapter;
  command?: SlashCommand;
  cliRequest?: CliRequest;
  isNew: boolean;
  hasThread: boolean;
}): Promise<CommandOutcome> {
  const {
    runtime,
    config,
    msg,
    bot,
    session,
    cliAdapter,
    command,
    cliRequest,
    isNew,
    hasThread,
  } = options;

  // 命令处理也独立守门，避免其他编排入口绕过消息路由的校验。
  if ((command || cliRequest) && !isBotRequestAllowed(config, msg.senderOpenId, msg.chatId)) {
    await bot.reply(msg.messageId, "当前账号或聊天未获授权，请联系管理员配置访问名单。", hasThread);
    return "handled";
  }

  // 各 CLI 的 session id 不互通，话题创建时定死引擎，想换只能新开话题。
  if (!isNew && cliRequest && cliRequest.cliId !== session.cliId) {
    await bot.reply(
      msg.messageId,
      `当前话题已经在使用 ${cliAdapter.displayName}。如需切换执行引擎，请新开一个话题。`,
      hasThread,
    );
    return "handled";
  }

  if (!command) return "continue";

  if (command.name === "help") {
    await bot.reply(msg.messageId, helpLines().join("\n"), hasThread);
    return "handled";
  }

  if (command.name === "team") {
    await bot.replyCard(
      msg.messageId,
      buildTeamCard({
        members: runtime.teamRegistry.members.map((member) => {
          const memberRuntime = runtime.botRuntimes.get(member.id);
          return {
            id: member.id,
            displayName: memberRuntime?.identity.name ?? member.id,
            role: member.role,
            cliName: runtime.getAdapter(member.defaultCliId).displayName,
            skills: member.skills,
            isLeader: member.id === runtime.teamRegistry.leaderBotId,
            ready: !!memberRuntime,
          };
        }),
      }),
      hasThread,
    );
    return "handled";
  }

  if (command.name === "status") {
    await bot.reply(
      msg.messageId,
      formatSessionStatus(session, config.id, cliAdapter),
      hasThread,
    );
    return "handled";
  }

  // 只读视图，放在会话关闭与执行中两道闸门之前：
  // 任务跑着的时候恰恰最需要回看历史，它既不建 CLI 也不动会话状态。
  // 和 /history 一样是只读视图，同样放在两道闸门之前。
  if (command.name === "cost") {
    const scoped = runtime.taskRecords
      .list()
      .filter(
        (record) => record.chatId === msg.chatId && record.botId === config.id,
      );
    const summary = summarizeCost(groupIntoTasks(scoped));
    console.log(
      `[成本] chat=${msg.chatId} bot=${config.id} ${summary.taskCount} 件 / ${summary.turnCount} 轮 / ${summary.totalTokens} tokens`,
    );
    await bot.replyCard(
      msg.messageId,
      buildCostCard({
        botName: runtime.botRuntimes.get(config.id)?.identity.name ?? config.id,
        summary,
        capacity: TASK_RECORD_CAPACITY,
      }),
      hasThread,
    );
    return "handled";
  }

  if (command.name === "history") {
    const { card, page } = renderHistoryPage({
      runtime,
      botId: config.id,
      chatId: msg.chatId,
    });
    console.log(
      `[历史] /history chat=${msg.chatId} bot=${config.id} 命中 ${page.total} 条，展示第 ${page.page}/${page.pageCount} 页`,
    );
    await bot.replyCard(msg.messageId, card, hasThread);
    return "handled";
  }

  if (command.name === "close") {
    const active = runtime.activeRuns.get(session.id);
    if (active && active.ownerOpenId !== msg.senderOpenId) {
      await bot.reply(msg.messageId, "只有当前任务发起人可以关闭执行中的会话。", hasThread);
      return "handled";
    }
    if (active && !active.committing) {
      // /close 连会话一起关，和卡片按钮共用同一个停止信号。
      active.cancelMode = "close";
      active.controller.abort();
    }
    if (session.status !== "closed") {
      await runtime.sessions.transition(session.id, "closed");
    }
    await bot.reply(
      msg.messageId,
      active?.committing
        ? "当前会话已关闭。本轮结果已开始提交，无法撤回。需要继续时，请新开一个话题。"
        : "当前会话已关闭。需要继续时，请新开一个话题。",
      hasThread,
    );
    return "handled";
  }

  if (session.status === "closed") {
    await bot.reply(
      msg.messageId,
      "这个话题的会话已经关闭，请新开一个话题继续。",
      hasThread,
    );
    return "handled";
  }

  if (command.name === "cd") {
    if (!command.path) {
      await bot.reply(
        msg.messageId,
        `当前工作目录：${session.workspaceDir}`,
        hasThread,
      );
      return "handled";
    }
    if (session.status === "active" || runtime.activeRuns.has(session.id)) {
      await bot.reply(
        msg.messageId,
        "当前任务仍在执行，结束后再切换工作目录。",
        hasThread,
      );
      return "handled";
    }
    try {
      const workspaceDir = await ensureAllowedWorkspace(resolveWorkspacePath(
        command.path,
        session.workspaceDir,
      ), config);
      // 目录检查期间另一条消息可能已经占位或换了绑定，旧命令不能再覆盖它。
      if (bindingChanged(runtime, session)) {
        await bot.reply(msg.messageId, "当前会话正在执行或已经更新，请等任务结束后重新操作。", hasThread);
        return "handled";
      }
      const changed = workspaceDir !== session.workspaceDir;
      await runtime.sessions.setWorkspaceDir(session.id, workspaceDir);
      await bot.reply(
        msg.messageId,
        changed
          ? `工作目录已切换到：${workspaceDir}\n下一条任务会在这里建立新的 CLI 会话。`
          : `当前工作目录已经是：${workspaceDir}`,
        hasThread,
      );
    } catch (error) {
      await bot.reply(
        msg.messageId,
        `无法切换工作目录：${(error as Error).message}`,
        hasThread,
      );
    }
    return "handled";
  }

  if (command.name === "schedule") {
    if (!command.request) {
      await bot.replyCard(
        msg.messageId,
        buildScheduleListCard(
          runtime.schedules.listForScope(config.id, msg.chatId),
          { botId: config.id, chatId: msg.chatId },
        ),
        hasThread,
      );
      return "handled";
    }
    // 带自然语言时交给 CLI，由它调用 schedule_manage 工具。
    return "continue";
  }

  if (session.status === "active" || runtime.activeRuns.has(session.id)) {
    await bot.reply(
      msg.messageId,
      "当前会话还在执行，请等任务结束后再追问。",
      hasThread,
    );
    return "handled";
  }

  if (command.name === "new") {
    await runtime.sessions.clearCliSessionId(session.id);
    await bot.replyCard(
      msg.messageId,
      buildSessionNoticeCard({
        title: "新会话已就绪",
        template: "green",
        detail: `下一条任务会由 ${cliAdapter.displayName} 开启全新的 CLI 会话。${cliAdapter.capabilities.nativeHistory === false ? "" : "\n\n旧会话仍然保留，可以随时用 `/resume` 找回来。"}`,
      }),
      hasThread,
    );
    return "handled";
  }

  if (command.name === "resume") {
    try {
      await ensureAllowedWorkspace(session.workspaceDir, config);
      const nativeSessions = filterResumableSessions(
        await listNativeCliSessions({
          adapter: cliAdapter,
          cwd: session.workspaceDir,
          scope: config.resumeScope,
        }),
        config.resumeScope,
      );
      if (bindingChanged(runtime, session)) {
        await bot.reply(msg.messageId, "当前会话正在执行或已经更新，请等任务结束后重新操作。", hasThread);
        return "handled";
      }
      await bot.replyCard(
        msg.messageId,
        buildResumeCard({
          agentSessionId: session.id,
          cliName: cliAdapter.displayName,
          ...(session.cliSessionId
            ? { currentCliSessionId: session.cliSessionId }
            : {}),
          sessions: nativeSessions,
        }),
        hasThread,
      );
    } catch (error) {
      await bot.reply(
        msg.messageId,
        `无法读取 ${cliAdapter.displayName} 会话：${(error as Error).message}`,
        hasThread,
      );
    }
    return "handled";
  }

  if (command.name === "compact") {
    if (cliAdapter.capabilities.nativeCompact === false) {
      const plan = cliAdapter.buildCompactPlan(session.cliSessionId ?? "");
      if (plan.protocol === "unsupported") await bot.reply(msg.messageId, plan.message, hasThread);
      return "handled";
    }
    if (!session.cliSessionId) {
      await bot.reply(
        msg.messageId,
        "当前还没有可整理的 CLI 会话。先完成一次任务，再使用 /compact。",
        hasThread,
      );
      return "handled";
    }
    // 检查通过，交给任务主线执行原生压缩。
    return "continue";
  }

  return "continue";
}
