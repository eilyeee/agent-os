/**
 * 消息路由：一条飞书消息在系统里怎么走。
 * 协作交接的认领与退回、会话准入、澄清接续都在这里，
 * 所以它必须是可测的——这也是它没有留在 index.ts 里的原因。
 */
import {
  buildClarificationSupersededCard,
  buildTaskCard,
} from "../im/card.js";
import type { Bot, IncomingMessage } from "../im/lark.js";
import {
  extractResourceKeys,
  resolveMentions,
  stripMentions,
} from "../im/message-parser.js";
import { buildBotPrompt, type BotConfig } from "../core/bot-registry.js";
import { isBotRequestAllowed } from "../core/access-control.js";
import { formatClarificationMessage } from "../core/clarification.js";
import {
  collaborationTurnKey,
  type CollaborationMessage,
} from "../core/collaboration.js";
import {
  KNOWN_COMMANDS,
  closestCommand,
  looksLikeCommand,
  parseCliRequest,
  parseCommand,
} from "../core/command-parser.js";
import { newTaskId, topicScopeId } from "../core/topic-task.js";
import { ensureWorkspaceDirectory } from "../core/workspace.js";
import { handleSessionCommand } from "./command-handler.js";
import {
  downloadMessageResources,
  runCliTurn,
  taskAdmission,
} from "./task-runner.js";
import type { AppRuntime, BotRuntime } from "./runtime.js";

/** 已经重投过一次的交接单，避免失败时无限重投。 */
const retriedHandoffs = new Set();
const HANDOFF_RETRY_MS = 60_000;

/**
 * 这一轮没能接住交接单：退回收件箱、释放去重键，并安排一次重投。
 * 只退回不重投的话，任务会永远躺在收件箱里等一个不会再来的投递。
 */
async function returnHandoff(
  runtime: AppRuntime,
  claimed: { message: CollaborationMessage; turnKey: string },
  replyToMessageId: string,
  targetIdentity: { openId: string; name: string },
): Promise<void> {
  const { message, turnKey } = claimed;
  runtime.collaborationInbox.register(message);
  runtime.processedCollaborationTurns.delete(turnKey);

  const sender = runtime.botRuntimes.get(message.fromBotId);
  if (!sender) {
    console.warn(`[协作] 交接单已退回但找不到来源 bot：${message.dispatchId}`);
    return;
  }

  if (retriedHandoffs.has(message.dispatchId)) {
    // 已经重投过一次还是没接住，交给人处理，不要继续自动重试。
    console.error(`[协作] 交接单重投后仍未接住：${message.dispatchId}`);
    await sender.bot
      .reply(
        replyToMessageId,
        `这项任务两次都没能交接成功（任务编号：${message.dispatchId}）。请直接在本话题里说明需要谁来接手。`,
        true,
      )
      .catch(() => undefined);
    return;
  }

  retriedHandoffs.add(message.dispatchId);
  console.warn(
    `[协作] 本轮未能开跑，交接单已退回，${HANDOFF_RETRY_MS / 1000}s 后重投：${message.dispatchId}`,
  );
  const timer = setTimeout(() => {
    void sender.bot
      .replyMention(
        replyToMessageId,
        targetIdentity,
        `重新投递（任务编号：${message.dispatchId}），请查看上方卡片。`,
        true,
      )
      .catch((error) =>
        console.error("[协作] 重投失败:", (error as Error).message),
      );
  }, HANDOFF_RETRY_MS);
  timer.unref();
}


export function createMessageHandler(options: {
  runtime: AppRuntime;
  config: BotConfig;
}): (msg: IncomingMessage, bot: Bot) => Promise<void> {
  const { runtime, config } = options;
  return async (msg, bot) => {
    const botRuntime = runtime.botRuntimes.get(config.id);
    if (!botRuntime) return;
    const resolved = resolveMentions(msg.text, msg.mentions);
    const hasThread = !!msg.threadId || !!msg.rootId;
    // 交接单一旦被领走就从收件箱消失，只要这一轮没真正开跑就必须放回去，
    // 否则任何提前返回或抛错都会让派出去的任务凭空消失，且再派也会被去重挡掉。
    let claimed: { message: CollaborationMessage; turnKey: string } | undefined;
    let dispatched = false;
    try {

    // ── 来自其他 bot 的消息：只有带着有效取件码才认领 ──
    let collaboration: CollaborationMessage | undefined;
    let senderRuntime: BotRuntime | undefined;
    if (msg.senderType === "app" || msg.senderType === "bot") {
      // 自动交接以接收方配置的人类负责人授权，撤销负责人权限后也不能继续烧引擎。
      if (!isBotRequestAllowed(config, config.ownerOpenId ?? "", msg.chatId)) {
        console.warn(`[准入] 已拒绝自动交接 bot=${config.id} chat=${msg.chatId}`);
        return;
      }
      const mentionedSelf = msg.mentions.some(
        (mention) => mention.openId === botRuntime.identity.openId,
      );
      const dispatchId = msg.text.match(/任务编号：([a-f0-9]{12})/)?.[1];
      const pending =
        msg.messageType === "post" && mentionedSelf && dispatchId
          ? runtime.collaborationInbox.consume(dispatchId, config.id, msg)
          : undefined;
      if (!pending) {
        console.log(
          `[协作] 忽略非目标 bot 消息 sender=${msg.senderOpenId} target=${config.id}`,
        );
        return;
      }
      const turnKey = collaborationTurnKey(pending);
      if (runtime.processedCollaborationTurns.has(turnKey)) {
        console.log(`[协作] 忽略重复消息 ${turnKey}`);
        return;
      }
      runtime.processedCollaborationTurns.add(turnKey);
      collaboration = pending;
      claimed = { message: pending, turnKey };
      senderRuntime = runtime.botRuntimes.get(pending.fromBotId);
      if (!senderRuntime) {
        console.log(`[协作] 找不到来源 bot: ${pending.fromBotId}`);
        return;
      }
    }

    // ── 群里没点名时，只有 Team Leader 接单 ──
    // 飞书会把群消息投递给群里**每一台**机器人，不带 @ 也一样（真机验证：
    // 一条 /status 三台 bot 全收到了）。不加这道门，一句「看一下 package.json」
    // 会让每台 bot 各起一个 CLI，在同一个工作目录里并发改同一个仓库。
    // 规则：@到我 → 我接；@了别人没@我 → 不接；谁都没@ → 只有 Team Leader 接。
    // 单聊没有「点名」一说，永远接。
    // collaboration 必须放行：交接单在上面已经被「认领」了（从收件箱消费掉），
    // 在这里提前 return 会让它凭空消失，而且去重键会挡住重派。
    if (!collaboration && msg.chatType !== "p2p") {
      // 认「点名了谁」只能靠**显示名**，不能靠 open_id：open_id 按应用隔离，
      // 同一台 bot 在别人的应用视角下是另一个 id。真机上栽过——
      // 用户 @了市场/运营/助理三台，developer 的应用看到的三个 open_id
      // 跟那三台自己上报的对不上，于是判定「谁都没点名」，按 Team Leader 接了单，
      // 四台 bot 一起弹澄清卡。自己那一份仍然用 open_id 兜一层：那个是准的。
      const selfOpenId = botRuntime.identity.openId;
      const selfName = botRuntime.identity.name;
      const otherBotNames = new Set(
        [...runtime.botRuntimes.values()]
          .filter((it) => it.identity.openId !== selfOpenId)
          .map((it) => it.identity.name)
          .filter(Boolean),
      );
      const mentionedMe = msg.mentions.some(
        (mention) =>
          mention.openId === selfOpenId ||
          (!!selfName && mention.name === selfName),
      );
      const mentionedOtherBot = msg.mentions.some((m) =>
        otherBotNames.has(m.name),
      );
      const addressedToSomeoneElse = !mentionedMe && mentionedOtherBot;
      const unaddressed = !mentionedMe && !mentionedOtherBot;
      if (
        addressedToSomeoneElse ||
        (unaddressed && runtime.teamRegistry.leaderBotId !== config.id)
      ) {
        return;
      }
    }

    // 交接单已由共享收件箱验证；人发来的消息必须在建会话、读附件之前过准入。
    if (!collaboration && !isBotRequestAllowed(config, msg.senderOpenId, msg.chatId)) {
      console.warn(`[准入] 已拒绝 bot=${config.id} chat=${msg.chatId} sender=${msg.senderOpenId}`);
      return;
    }

    // 命令解析吃的是「精确剥离 @提及之后」的文本：mentions 里有确切的提及结构，
    // 让解析器再用正则去猜一遍边界，@ 后面不打空格（@agent-os/history）就会漏判。
    const withoutMentions = stripMentions(msg.text, msg.mentions);
    const command = parseCommand(withoutMentions);
    const cliRequest = parseCliRequest(withoutMentions);
    // 以 / 开头显然是想敲命令，打错一个字母不该变成一次 CLI 调用：
    // 真机上 `/schdule`（少个 e）被当成任务派了出去，跑满 52 秒、记进历史，
    // 还自动流转给队友做了一轮互审——一个 typo 换来三次引擎调用。
    if (!command && !cliRequest) {
      const attempted = looksLikeCommand(withoutMentions);
      if (attempted && !KNOWN_COMMANDS.includes(attempted as never)) {
        const guess = closestCommand(attempted);
        await bot.reply(
          msg.messageId,
          [
            `没有 /${attempted} 这个命令。`,
            ...(guess ? [`你是不是想输 /${guess}？`] : []),
            "发送 /help 可以查看全部命令；要交给我做事，直接写清楚要做什么就行。",
          ].join("\n"),
          hasThread,
        );
        return;
      }
    }

    if (cliRequest && !cliRequest.prompt) {
      await bot.reply(
        msg.messageId,
        `请在 /${cliRequest.cliId} 后面写下任务，例如：/${cliRequest.cliId} 检查项目状态`,
        hasThread,
      );
      return;
    }

    // 只 @了机器人、没写任务时，连会话都不要建：
    // 在飞书 @ 下拉框里回车选中，很容易顺手把消息也发出去。
    // 放在 sessions.resolve 之前——否则新会话会停在 creating，
    // 这个话题后面每一条消息都只会收到「会话正在准备」。
    if (
      !collaboration &&
      !command &&
      !cliRequest &&
      !withoutMentions &&
      extractResourceKeys(msg.messageType, msg.rawContent).length === 0
    ) {
      console.log(
        `[收到] bot=${config.id} chat=${msg.chatId} type=${msg.messageType} sender=${msg.senderOpenId} 空任务，仅提示不建会话`,
      );
      await bot.reply(
        msg.messageId,
        [
          "收到，但这条消息里没有任务内容。",
          "直接在 @ 后面写清楚要做什么即可，例如：读一下 package.json，告诉我怎么启动。",
          "发送 /help 可以查看全部命令。",
        ].join("\n"),
        hasThread,
      );
      return;
    }

    // 话题和任务是两件事：话题标识用来找「这个话题里有没有待办的卡」，
    // 任务标识用来串起「这一件事」的全部轮次。混用的话，同话题里两件
    // 毫不相干的事会共用一个编号，而那个编号还印在卡片上给用户看。
    const topicId = topicScopeId(msg);
    // 用户没点澄清卡片、直接在话题里补一句：旧卡片失效，新消息进入同一任务。
    const pendingClarification =
      msg.senderType !== "app" && msg.senderType !== "bot" && !command
        ? runtime.clarificationFlows.findForTopic(topicId, config.id)
        : undefined;

    // 一件事从这里开始编号。三种情况沿用已有的编号而不是新开一个：
    //   - 用户在话题里补一句话来答澄清 → 属于当初那件事
    //   - 队友交接回来 → 属于派活的那件事
    // 其余都是新发起的一件事。
    const taskId =
      pendingClarification?.taskId ?? collaboration?.taskId ?? newTaskId();

    const resolvedSession = await runtime.sessions.resolve(
      msg,
      cliRequest?.cliId ?? config.defaultCliId,
      config.id,
      collaboration?.workspaceDir ?? config.workspaceDir,
    );
    let session = resolvedSession.session;
    const { isNew } = resolvedSession;
    // 新话题里第一条就是命令时，不要把会话卡在「创建中」。
    if (command && isNew && session.status === "creating") {
      session = await runtime.sessions.transition(session.id, "idle");
    }
    const cliAdapter = runtime.getAdapter(session.cliId);

    console.log(
      `[收到] bot=${config.id} chat=${msg.chatId} type=${msg.messageType} threadId=${msg.threadId} rootId=${msg.rootId} sender=${msg.senderOpenId}`,
    );
    console.log(`  [消息] 长度=${resolved.length}`);
    console.log(
      `  [会话] ${isNew ? "新建" : "复用"} id=${session.id} status=${session.status}`,
    );

    const outcome = await handleSessionCommand({
      runtime,
      config,
      msg,
      bot,
      session,
      cliAdapter,
      ...(command ? { command } : {}),
      ...(cliRequest ? { cliRequest } : {}),
      isNew,
      hasThread,
    });
    if (outcome === "handled") return;

    if (session.status === "closed") {
      await bot.reply(
        msg.messageId,
        "这个话题的会话已经关闭，请新开一个话题继续。",
        hasThread,
      );
      return;
    }
    if (!isNew && session.status === "creating") {
      await bot.reply(msg.messageId, "当前会话正在准备，请稍后再追问。", hasThread);
      return;
    }
    const admission = taskAdmission(runtime, session);
    if (!admission.ok) {
      await bot.reply(msg.messageId, admission.reason, hasThread);
      return;
    }

    // 协作任务沿用来源工作目录，目标 bot 才能看到刚完成的改动。
    if (collaboration && session.workspaceDir !== collaboration.workspaceDir) {
      await ensureWorkspaceDirectory(collaboration.workspaceDir);
      session = await runtime.sessions.setWorkspaceDir(
        session.id,
        collaboration.workspaceDir,
      );
    }

    if (pendingClarification) {
      runtime.clarificationFlows.delete(pendingClarification.token);
      if (pendingClarification.cardMessageId) {
        await bot
          .updateCard(
            pendingClarification.cardMessageId,
            buildClarificationSupersededCard(pendingClarification),
          )
          .catch((error) =>
            console.warn("[澄清] 旧卡片更新失败:", (error as Error).message),
          );
      }
    }

    await downloadMessageResources(
      botRuntime,
      msg.messageId,
      extractResourceKeys(msg.messageType, msg.rawContent),
    );

    const rawTaskText =
      command?.name === "schedule" && command.request
        ? [
            "用户想通过定时任务完成下面这件事，请调用 schedule_manage 工具落地。",
            `用户原话：${command.request}`,
            "cron 用五段式（分 时 日 月 周）。prompt 要写成触发时可独立执行的完整任务描述。",
          ].join("\n\n")
        : (cliRequest?.prompt ?? resolved);
    const taskText = pendingClarification
      ? formatClarificationMessage(pendingClarification, rawTaskText)
      : (collaboration?.prompt ?? rawTaskText);
    const isCompacting = command?.name === "compact";

    // 只等「这一轮是否真的接手」这一个信号，不等任务跑完——
    // 卡片发出去大约百毫秒，事件回调仍然很快返回。
    let started = false;
    let signalStarted: () => void = () => undefined;
    const startedSignal = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });

    // 交接来的这一轮，发起人是派活的那台 bot，名字现成的；
    // 人发起的才需要查通讯录——查不到就留空，卡片会退化成 open_id 前缀。
    const ownerName = senderRuntime
      ? senderRuntime.identity.name
      : await bot.resolveUserName(msg.senderOpenId);

    const turn = runCliTurn({
      runtime,
      botRuntime,
      session,
      taskId,
      replyToMessageId: msg.messageId,
      replyInThread: hasThread,
      ownerOpenId: msg.senderOpenId,
      ...(msg.senderUnionId ? { ownerUnionId: msg.senderUnionId } : {}),
      // 交接轮的「发起人」是那台派活的 bot，它没法回答澄清、也没法批审批。
      // 这种时候拍板权归这台 bot 配置里的负责人——也就是人。
      decisionOwnerOpenId: collaboration
        ? (config.ownerOpenId ?? msg.senderOpenId)
        : msg.senderOpenId,
      ...(!collaboration && msg.senderUnionId
        ? { decisionOwnerUnionId: msg.senderUnionId }
        : {}),
      // 交接来的这一轮发起人是派活的那台 bot，不是人。
      origin: collaboration ? "handoff" : "user",
      ...(ownerName ? { ownerName } : {}),
      prompt: buildBotPrompt(
        config,
        taskText,
        runtime.teamRegistry.contextFor(config.id),
        runtime.defaultProductDeliveryMode,
      ),
      taskText,
      cardTitle: isCompacting ? "整理上下文" : cliAdapter.displayName,
      ...(collaboration ? { collaboration } : {}),
      ...(senderRuntime ? { senderRuntime } : {}),
      ...(isCompacting && command?.name === "compact"
        ? {
            compact: command.instructions
              ? { instructions: command.instructions }
              : {},
          }
        : {}),
      // 只有进度卡真的发出去、CLI 即将启动，才算接手。
      // runCliTurn 在此之前还有占位冲突、状态落盘失败、卡片发送失败三条退出路径。
      onStarted: () => {
        started = true;
        signalStarted();
      },
    });

    // 启动阶段的失败要在话题里说清楚；任务本身的失败由 runCliTurn 自己渲染。
    const settled = turn.then(
      () => undefined,
      async (error: unknown) => {
        const message = (error as Error).message;
        console.error("[任务] 启动失败:", message);
        await bot
          .replyCard(
            msg.messageId,
            // 标题给人看，原始异常收进折叠区，不抢走注意力。
            buildTaskCard({
              title: "任务没有启动",
              status: "failed",
              detail: "这条消息没有进入执行。请稍后在当前话题里重试。",
              technicalDetail: message,
            }),
            hasThread,
          )
          .catch(() => undefined);
      },
    );
    void settled;

    await Promise.race([startedSignal, settled]);
    dispatched = started;
    } finally {
      if (claimed && !dispatched) {
        await returnHandoff(runtime, claimed, msg.messageId, botRuntime.identity);
      }
    }
  };
}
