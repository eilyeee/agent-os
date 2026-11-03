/**
 * 集成验证用的假飞书。
 * 实现真实的 Bot 接口，把所有出站调用记录下来供断言；
 * 事件载荷按飞书开放平台真实结构构造（双层 JSON、post 富文本、mentions 占位符）。
 */

let seq = 0;
const nextId = (prefix) => `${prefix}_${(seq += 1).toString().padStart(4, "0")}`;

export function createFakeBot(identity = { openId: "ou_bot", name: "测试机器人" }) {
  const sent = [];
  /** open_id → 显示名。默认空的：真机上没有通讯录权限时就是查不到，
   *  让退化路径成为测试里的默认路径，而不是一条没人走过的分支。 */
  const names = new Map();
  const bot = {
    identity,
    sent,
    names,
    client: {},
    /** 让测试可以模拟飞书接口报错。 */
    failNext: null,

    async getIdentity() {
      return identity;
    },
    async reply(messageId, text, replyInThread = false) {
      if (bot.failNext === "reply") {
        bot.failNext = null;
        throw new Error("飞书 500：消息发送失败");
      }
      const id = nextId("om");
      sent.push({ kind: "text", messageId, text, replyInThread, id });
      return id;
    },
    async replyCard(messageId, card, replyInThread = false) {
      if (bot.failNext === "replyCard") {
        bot.failNext = null;
        throw new Error("飞书 500：卡片发送失败");
      }
      const id = nextId("om");
      sent.push({ kind: "card", messageId, card, replyInThread, id });
      return id;
    },
    async replyMention(messageId, target, text, replyInThread = false) {
      const id = nextId("om");
      sent.push({ kind: "mention", messageId, target, text, replyInThread, id });
      return id;
    },
    // 测试里默认查不到名字，逼着用例自己声明「这个人叫什么」，
    // 免得真机上没权限时的退化路径永远没人走过。
    async resolveUserName(openId) {
      return names.get(openId);
    },

    async createThread(chatId, text) {
      const id = nextId("om");
      sent.push({ kind: "thread", chatId, text, id });
      return id;
    },
    async updateCard(messageId, card) {
      if (bot.failNext === "updateCard") {
        bot.failNext = null;
        throw new Error("飞书 500：卡片更新失败");
      }
      sent.push({ kind: "update", messageId, card });
    },
    async downloadResource(messageId, fileKey, type, saveDir) {
      sent.push({ kind: "download", messageId, fileKey, type });
      return `${saveDir}/${fileKey}.bin`;
    },
    async subscribeToDocumentComments() {
      sent.push({ kind: "subscribe" });
    },
    async replyToDocumentComment(comment, text) {
      sent.push({ kind: "comment", commentId: comment.commentId, text });
    },
    async setDocumentCommentWorking(comment, active) {
      sent.push({ kind: "reaction", commentId: comment.commentId, active });
    },
  };
  return bot;
}

/** 出站记录的查询助手，让断言读起来像话。 */
export function outbound(bot) {
  return {
    all: () => bot.sent,
    of: (kind) => bot.sent.filter((s) => s.kind === kind),
    lastCard: () => [...bot.sent].reverse().find((s) => s.kind === "card")?.card,
    lastUpdate: () => [...bot.sent].reverse().find((s) => s.kind === "update")?.card,
    lastText: () => [...bot.sent].reverse().find((s) => s.kind === "text")?.text,
    /** 卡片里所有回调按钮携带的 value，用来驱动下一步交互。 */
    callbacks: (card) => {
      const found = [];
      const walk = (node) => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== "object") return;
        if (node.type === "callback" && node.value) found.push(node.value);
        if (node.action_type === "form_submit" && node.value) found.push(node.value);
        Object.values(node).forEach(walk);
      };
      walk(card);
      return found;
    },
    contains: (text) => JSON.stringify(bot.sent).includes(text),
  };
}

/** 一条真实结构的飞书群消息：content 是套在事件里的 JSON 字符串。 */
export function userMessage(text, overrides = {}) {
  return {
    messageId: overrides.messageId ?? nextId("om"),
    chatId: overrides.chatId ?? "oc_test",
    chatType: "group",
    messageType: "text",
    text,
    rootId: overrides.rootId ?? "",
    threadId: overrides.threadId ?? "omt_test",
    senderType: "user",
    senderOpenId: overrides.senderOpenId ?? "ou_owner",
    senderUnionId: overrides.senderUnionId ?? "on_owner",
    mentions: overrides.mentions ?? [],
    rawContent: JSON.stringify({ text }),
  };
}

/** bot 之间的派活消息：富文本 + @提及 + 任务编号。 */
export function botHandoffMessage(dispatchId, targetOpenId, overrides = {}) {
  const text = `@_user_1 新任务已派发（任务编号：${dispatchId}），请查看上方卡片。`;
  return {
    messageId: overrides.messageId ?? nextId("om"),
    chatId: overrides.chatId ?? "oc_test",
    chatType: "group",
    messageType: "post",
    text,
    rootId: overrides.rootId ?? "",
    threadId: overrides.threadId ?? "omt_test",
    senderType: "app",
    senderOpenId: overrides.senderOpenId ?? "ou_sender_bot",
    senderUnionId: "",
    mentions: [{ key: "@_user_1", name: "目标机器人", openId: targetOpenId }],
    rawContent: JSON.stringify({
      content: [[{ tag: "at", user_id: targetOpenId }, { tag: "text", text }]],
    }),
  };
}

/** 卡片回调，operator 和所在群都由飞书回传，不能信按钮里自带的身份与作用域。 */
export function cardAction(value, overrides = {}) {
  return {
    operatorOpenId: overrides.operatorOpenId ?? "ou_owner",
    operatorUnionId: overrides.operatorUnionId ?? "on_owner",
    messageId: overrides.messageId ?? "om_card",
    chatId: overrides.chatId ?? "oc_test",
    value,
    formValue: overrides.formValue ?? {},
  };
}

/**
 * 假执行引擎：用一个真的子进程按脚本吐出 CliEvent。
 * 这样 runner.ts 的 spawn、逐行解析、结算、取消、工具调用去重全部真实经历，
 * 只跳过引擎协议翻译那一层（那一层已经用真实 CLI 验证过了）。
 */
const EMIT_SCRIPT = `
  const events = JSON.parse(process.argv[1]);
  const exitCode = Number(process.argv[2] || 0);
  let i = 0;
  const step = () => {
    if (i >= events.length) { process.exit(exitCode); return; }
    const e = events[i++];
    const { __delayMs, ...event } = e;
    console.log(JSON.stringify(event));
    setTimeout(step, __delayMs || 0);
  };
  step();
`;

export function createFakeAdapter(events, options = {}) {
  const prompts = [];
  const adapter = {
    id: options.id ?? "claude",
    command: process.execPath,
    displayName: options.displayName ?? "假引擎",
    // 默认按「能派子 Agent」算，用例要验不能派的引擎时自己覆盖
    capabilities: options.capabilities ?? { subagents: true },
    prompts,
    buildArgs(prompt) {
      prompts.push({ kind: "new", prompt });
      return ["-e", EMIT_SCRIPT, JSON.stringify(events), String(options.exitCode ?? 0)];
    },
    buildResumeArgs(prompt, sessionId) {
      prompts.push({ kind: "resume", prompt, sessionId });
      return ["-e", EMIT_SCRIPT, JSON.stringify(events), String(options.exitCode ?? 0)];
    },
    buildCompactPlan(sessionId) {
      return { protocol: "claude-stream-json", command: process.execPath, args: ["-e", "process.exit(0)"], prompt: "/compact", sessionId };
    },
    parseEvents(line) {
      try {
        const e = JSON.parse(line);
        return e && typeof e.type === "string" ? [e] : [];
      } catch {
        return [];
      }
    },
  };
  return adapter;
}

/** 轮询等待某个条件成立，用于等后台任务跑完。 */
export async function waitFor(check, { timeoutMs = 15_000, label = "条件" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`等待超时：${label}`);
}
