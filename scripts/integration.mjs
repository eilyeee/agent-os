/**
 * 集成验证：用假飞书驱动真实的编排代码（app/ 与 core/），
 * 覆盖冒烟测试够不到的那一层——命令分发、卡片回调、逐题澄清、审批门、权限校验。
 * 仍然覆盖不到的是飞书长连接本身和 CLI 子进程，那两层只能在真机验收。
 * 用法：pnpm integration
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFakeBot, createFakeAdapter, outbound, cardAction, userMessage,
  botHandoffMessage, waitFor,
} from "./fakes.mjs";

const R = (p) => import(new URL(p, `file://${process.cwd()}/dist/`).href);
let pass = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.stack?.split("\n").slice(0,3).join("\n     ")}`); process.exitCode = 1; }
};

const { SessionManager } = await R("core/session-manager.js");
const { JsonSessionStore } = await R("core/session-store.js");
const { TeamRegistry } = await R("core/team-registry.js");
const { CollaborationInbox } = await R("core/collaboration.js");
const { ClarificationFlowStore, ClarificationRequestSchema } = await R("core/clarification.js");
const { ProductSpecFlowStore, ProductSpecRequestSchema } = await R("core/product-spec.js");
const { ApprovalFlowStore, ApprovalRequestSchema } = await R("core/approval.js");
const { JsonScheduleStore } = await R("core/schedule.js");
const { JsonTaskRecordStore, TASK_ANSWER_LIMIT, queryTaskRecords } = await R("core/task-record.js");
const { getCliAdapter } = await R("cli/registry.js");
const { handleSessionCommand } = await R("app/command-handler.js");
const { createCardActionHandler } = await R("app/card-action-handler.js");
const { parseCommand } = await R("core/command-parser.js");

const dir = mkdtempSync(join(tmpdir(), "agentos-it-"));
let n = 0;

const BOTS = [
  { id: "developer", appId: "a", appSecret: "b", defaultCliId: "claude", role: "开发工程师",
    skills: [], systemPrompt: "", workspaceDir: process.cwd(), collaborationMaxRounds: 16,
    resumeScope: "agent-os", idleTimeoutMinutes: 15, maxRuntimeMinutes: 120,
    // 真机配置里每台 bot 都有：交接轮的拍板权要归到这个人身上
    ownerOpenId: "ou_owner" },
  { id: "reviewer", appId: "c", appSecret: "d", defaultCliId: "codex", role: "审查",
    skills: [], systemPrompt: "", workspaceDir: process.cwd(), collaborationMaxRounds: 16,
    resumeScope: "agent-os", idleTimeoutMinutes: 15, maxRuntimeMinutes: 120, ownerOpenId: "ou_owner" },
];

// 这些用户在旧用例里检验「已获准访问，但不是当前流程主人」，不能被入口名单提前挡住。
for (const bot of BOTS) {
  bot.allowedUserOpenIds = ["ou_owner", "ou_other", "ou_jia", "ou_yi", "ou_sender_bot", "ou_lin", "ou_nobody"];
  bot.allowedWorkspaceDirs = [process.cwd(), dir];
}

async function makeRuntime() {
  n += 1;
  const sessions = await SessionManager.open({
    store: new JsonSessionStore(join(dir, `s${n}.json`)),
  });
  const bots = new Map();
  for (const config of BOTS) {
    bots.set(config.id, {
      config,
      bot: createFakeBot({ openId: `ou_${config.id}`, name: config.id }),
      identity: { openId: `ou_${config.id}`, name: config.id },
    });
  }
  return {
    sessions,
    getAdapter: getCliAdapter,
    teamRegistry: new TeamRegistry("developer", BOTS),
    defaultProductDeliveryMode: "lark-doc",
    activeRuns: new Map(),
    contextWindows: new Map(),
    botRuntimes: bots,
    processedCollaborationTurns: new Set(),
    collaborationInbox: new CollaborationInbox(),
    clarificationFlows: new ClarificationFlowStore(),
    productSpecFlows: new ProductSpecFlowStore(),
    approvalFlows: new ApprovalFlowStore(),
    schedules: await JsonScheduleStore.open(join(dir, `sched${n}.json`)),
    taskRecords: await JsonTaskRecordStore.open(join(dir, `tasks${n}.json`)),
  };
}

async function seedSession(runtime, { botId = "developer", status = "idle", threadId } = {}) {
  const msg = userMessage("x", { threadId: threadId ?? `omt_${n}_${Math.random().toString(36).slice(2, 8)}` });
  const { session } = await runtime.sessions.resolve(msg, "claude", botId, process.cwd());
  if (status !== "creating") await runtime.sessions.transition(session.id, status === "active" ? "active" : "idle");
  if (status === "closed") await runtime.sessions.transition(session.id, "closed");
  return { session: runtime.sessions.get(session.id), msg };
}

const runCommand = async (runtime, session, msg, text, botId = "developer") => {
  const br = runtime.botRuntimes.get(botId);
  return {
    outcome: await handleSessionCommand({
      runtime, config: br.config, msg, bot: br.bot, session,
      cliAdapter: getCliAdapter(session.cliId),
      command: parseCommand(text), isNew: false, hasThread: true,
    }),
    bot: br.bot,
  };
};

// ─────────────────────────── 命令分发 ───────────────────────────
console.log("斜杠命令");

await t("/help 列出全部命令", async () => {
  const rt = await makeRuntime();
  const { session, msg } = await seedSession(rt);
  const { outcome, bot } = await runCommand(rt, session, msg, "/help");
  assert.equal(outcome, "handled");
  const text = outbound(bot).lastText();
  // 断言 /help **真实回复的整段文本**，不是只比命令名。
  // 只比名字的话，把 handler 改回硬编码一份清单（正是单一来源要防的事）照样绿——
  // 描述文案全丢了、用户看不到 /history 能筛选能翻页，测试却一片绿。
  const { COMMAND_DOCS } = await R("app/commands.js");
  assert.deepEqual(
    text.split("\n"),
    COMMAND_DOCS.map((d) => `${d.usage} ${d.description}`),
    "/help 回的每一行都要来自 COMMAND_DOCS——顺序、参数写法、描述，一字不差",
  );
  // 真去读 README 的命令表来比，不要在这儿再抄一份清单：
  // 抄一份的话，README 漏掉一条命令时两边一起漏，这条用例照样绿——
  // 它的注释声称锁住了「文档和产品一致」，实际上谁也没锁。
  const repoRoot = new URL("../", import.meta.url);
  const commandsIn = (file) => {
    const md = readFileSync(new URL(file, repoRoot), "utf8");
    return new Set(
      [...md.matchAll(/^\|\s*`(\/[a-z]+)[^`]*`\s*\|/gm)].map((m) => m[1]),
    );
  };
  const helpCommands = new Set(
    [...text.matchAll(/(\/[a-z]+)/g)].map((m) => m[1]),
  );
  for (const file of ["README.md", "README.zh-CN.md"]) {
    const documented = commandsIn(file);
    assert.ok(documented.size >= 10, `${file} 里没解析出命令表，正则该跟着文档格式改`);
    for (const command of documented) {
      assert.ok(helpCommands.has(command), `${file} 写了 ${command}，但 /help 没有`);
    }
    for (const command of helpCommands) {
      assert.ok(documented.has(command), `/help 有 ${command}，但 ${file} 没写`);
    }
  }
});

await t("/status 展示两层会话与工作目录", async () => {
  const rt = await makeRuntime();
  const { session, msg } = await seedSession(rt);
  await rt.sessions.setCliSessionId(session.id, "cli-abc");
  const fresh = rt.sessions.get(session.id);
  const { bot } = await runCommand(rt, fresh, msg, "/status");
  const text = outbound(bot).lastText();
  assert.ok(text.includes("机器人：developer"));
  assert.ok(text.includes("cli-abc"), "没有显示 CLI 会话");
  assert.ok(text.includes(process.cwd()));
});

/** 往历史里塞一条记录，只覆盖各用例关心的字段。 */
// 同上：默认一条记录就是一件独立的事
let seedSeq = 0;
const seedRecord = (rt, over = {}) =>
  rt.taskRecords.append({
    taskId: `seed-${(seedSeq += 1)}`, botId: "developer", chatId: "oc_test", threadId: "omt_seed",
    sessionId: "s-seed", cliId: "claude", workspaceDir: process.cwd(), origin: "user",
    ownerOpenId: "ou_owner", title: "Claude Code", prompt: "看一下项目", status: "success",
    answer: "做完了", startedAt: "2026-08-24T02:00:00.000Z",
    finishedAt: "2026-08-24T02:00:12.000Z", toolCount: 1, completedToolCount: 1, ...over,
  });

await t("/history 只列当前群当前机器人的任务，最新的在最前面", async () => {
  const rt = await makeRuntime();
  const { session, msg } = await seedSession(rt);
  await seedRecord(rt, { prompt: "本群早一点的任务" });
  await seedRecord(rt, { prompt: "别的群的任务", chatId: "oc_another" });
  await seedRecord(rt, { prompt: "本群 reviewer 的任务", botId: "reviewer" });
  await seedRecord(rt, {
    prompt: "本群最新的任务", status: "failed",
    startedAt: "2026-08-24T03:00:00.000Z", finishedAt: "2026-08-24T03:00:12.000Z",
  });

  const { outcome, bot } = await runCommand(rt, session, msg, "/history");
  assert.equal(outcome, "handled");
  const json = JSON.stringify(outbound(bot).lastCard());
  assert.ok(json.includes("本群最新的任务") && json.includes("本群早一点的任务"));
  assert.equal(json.includes("别的群的任务"), false, "别的群的记录不能出现在卡片里");
  assert.equal(json.includes("本群 reviewer 的任务"), false, "别的机器人的记录不能出现在卡片里");
  assert.ok(
    json.indexOf("本群最新的任务") < json.indexOf("本群早一点的任务"),
    "时间倒序：最新的一条要排在最前面",
  );
  assert.ok(json.includes("执行失败") && json.includes("已完成"), "每行要看得出状态");
  assert.ok(json.includes("12 秒"), "每行要看得出耗时");
});

await t("/history 没有历史时说明情况并给出下一步", async () => {
  const rt = await makeRuntime();
  const { session, msg } = await seedSession(rt);
  const { outcome, bot } = await runCommand(rt, session, msg, "/history");
  assert.equal(outcome, "handled");
  const json = JSON.stringify(outbound(bot).lastCard());
  assert.ok(json.includes("还没有任务记录"), "空历史要说清楚是没有记录");
  assert.ok(json.includes("@ 我"), "空状态要告诉用户怎么开始");
});

await t("/history 在任务执行中照常可用，且不改会话状态", async () => {
  const rt = await makeRuntime();
  const { session, msg } = await seedSession(rt, { status: "active" });
  await seedRecord(rt, { prompt: "上一轮做过的事" });
  const { outcome, bot } = await runCommand(rt, session, msg, "/history");
  assert.equal(outcome, "handled");
  assert.ok(JSON.stringify(outbound(bot).lastCard()).includes("上一轮做过的事"));
  assert.equal(rt.sessions.get(session.id).status, "active", "查历史不该动会话状态");
});

await t("/team 展示成员、引擎与连接状态", async () => {
  const rt = await makeRuntime();
  const { session, msg } = await seedSession(rt);
  const { bot } = await runCommand(rt, session, msg, "/team");
  const json = JSON.stringify(outbound(bot).lastCard());
  assert.ok(json.includes("developer") && json.includes("reviewer"));
  assert.ok(json.includes("Team Leader"));
  assert.ok(json.includes("已连接"));
  assert.ok(json.includes("Claude Code") && json.includes("Codex"));
});

await t("/cd 切换目录并解除旧 CLI 会话", async () => {
  const rt = await makeRuntime();
  const { session, msg } = await seedSession(rt);
  await rt.sessions.setCliSessionId(session.id, "cli-old");
  const { bot } = await runCommand(rt, rt.sessions.get(session.id), msg, `/cd ${dir}`);
  assert.equal(rt.sessions.get(session.id).workspaceDir, realpathSync(dir));
  assert.equal(rt.sessions.get(session.id).cliSessionId, undefined, "切目录后旧 CLI 会话必须解绑");
  assert.ok(outbound(bot).lastText().includes("下一条任务会在这里建立新的 CLI 会话"));
});

await t("/cd 到不存在的目录不改变当前目录", async () => {
  const rt = await makeRuntime();
  const { session, msg } = await seedSession(rt);
  const before = session.workspaceDir;
  const { bot } = await runCommand(rt, session, msg, "/cd ./definitely-not-here");
  assert.equal(rt.sessions.get(session.id).workspaceDir, before);
  assert.ok(outbound(bot).lastText().includes("无法切换工作目录"));
});

await t("/cd 在任务执行中被拒绝", async () => {
  const rt = await makeRuntime();
  const { session, msg } = await seedSession(rt, { status: "active" });
  const { bot } = await runCommand(rt, session, msg, "/cd /tmp");
  assert.ok(outbound(bot).lastText().includes("结束后再切换"));
});

await t("/close 会中止运行中的任务并关闭会话", async () => {
  const rt = await makeRuntime();
  const { session, msg } = await seedSession(rt, { status: "active" });
  const controller = new AbortController();
  rt.activeRuns.set(session.id, { controller, ownerOpenId: "ou_owner" });
  await runCommand(rt, session, msg, "/close");
  assert.equal(controller.signal.aborted, true, "/close 没有真正中止任务");
  assert.equal(rt.activeRuns.get(session.id).cancelMode, "close");
  assert.equal(rt.sessions.get(session.id).status, "closed");
});

await t("[授权] 已获准访问的非发起人也不能用 /close 停掉别人的执行", async () => {
  const rt = await makeRuntime();
  const { session, msg } = await seedSession(rt, { status: "active" });
  const controller = new AbortController();
  rt.activeRuns.set(session.id, { controller, ownerOpenId: "ou_owner" });
  const { bot } = await runCommand(rt, session, { ...msg, senderOpenId: "ou_other" }, "/close");
  assert.equal(controller.signal.aborted, false);
  assert.equal(rt.sessions.get(session.id).status, "active");
  assert.equal(rt.activeRuns.get(session.id).cancelMode, undefined);
  assert.match(outbound(bot).lastText(), /只有当前任务发起人/);
});

await t("[授权] /cd 拒绝允许目录之外的真实目录，原会话保持不变", async () => {
  const rt = await makeRuntime();
  const { session, msg } = await seedSession(rt);
  const br = rt.botRuntimes.get("developer");
  const config = { ...br.config, allowedWorkspaceDirs: [process.cwd()] };
  await handleSessionCommand({ runtime: rt, config, msg, bot: br.bot, session,
    cliAdapter: getCliAdapter(session.cliId), command: parseCommand(`/cd ${dir}`), isNew: false, hasThread: true });
  assert.equal(rt.sessions.get(session.id).workspaceDir, process.cwd());
  assert.match(outbound(br.bot).lastText(), /不在允许范围/);
});

await t("[并发] 任务已占位但状态尚未落盘时，不能切目录或恢复绑定", async () => {
  for (const command of [`/cd ${dir}`, "/new", "/resume"]) {
    const rt = await makeRuntime();
    const seeded = await seedSession(rt);
    const session = await rt.sessions.setCliSessionId(seeded.session.id, "project-a-context");
    rt.activeRuns.set(session.id, { controller: new AbortController(), ownerOpenId: "ou_owner" });
    const { bot } = await runCommand(rt, session, seeded.msg, command);
    assert.equal(rt.sessions.get(session.id).workspaceDir, process.cwd(), command);
    assert.equal(rt.sessions.get(session.id).cliSessionId, "project-a-context", command);
    assert.match(outbound(bot).lastText(), /执行|结束/, command);
  }
});

await t("[并发] /cd 检查目录期间启动任务，旧命令不能再改会话绑定", async () => {
  const rt = await makeRuntime();
  const { session, msg } = await seedSession(rt);
  const changing = runCommand(rt, session, msg, `/cd ${dir}`);
  rt.activeRuns.set(session.id, { controller: new AbortController(), ownerOpenId: "ou_owner" });
  await changing;
  assert.equal(rt.sessions.get(session.id).workspaceDir, process.cwd());
});

await t("会话关闭后除 /close /help 外都被挡住", async () => {
  const rt = await makeRuntime();
  const { session, msg } = await seedSession(rt, { status: "closed" });
  const { bot } = await runCommand(rt, session, msg, "/cd /tmp");
  assert.ok(outbound(bot).lastText().includes("已经关闭"));
});

await t("/new 清空 CLI 会话绑定", async () => {
  const rt = await makeRuntime();
  const { session, msg } = await seedSession(rt);
  await rt.sessions.setCliSessionId(session.id, "cli-x");
  const { bot } = await runCommand(rt, rt.sessions.get(session.id), msg, "/new");
  assert.equal(rt.sessions.get(session.id).cliSessionId, undefined);
  assert.ok(JSON.stringify(outbound(bot).lastCard()).includes("新会话已就绪"));
});

await t("/compact 在没有 CLI 会话时给出明确指引", async () => {
  const rt = await makeRuntime();
  const { session, msg } = await seedSession(rt);
  const { outcome, bot } = await runCommand(rt, session, msg, "/compact");
  assert.equal(outcome, "handled");
  assert.ok(outbound(bot).lastText().includes("先完成一次任务"));
});

await t("/compact 有 CLI 会话时放行给任务主线", async () => {
  const rt = await makeRuntime();
  const { session, msg } = await seedSession(rt);
  await rt.sessions.setCliSessionId(session.id, "cli-x");
  const { outcome } = await runCommand(rt, rt.sessions.get(session.id), msg, "/compact 保留接口约定");
  assert.equal(outcome, "continue", "/compact 应该继续走任务主线");
});

await t("/schedule 无参数直接出列表卡，不启动 CLI", async () => {
  const rt = await makeRuntime();
  await rt.schedules.create({ botId: "developer", chatId: "oc_test", name: "日志巡检", cron: "0 * * * *", prompt: "查日志" });
  const { session, msg } = await seedSession(rt);
  const { outcome, bot } = await runCommand(rt, session, msg, "/schedule");
  assert.equal(outcome, "handled");
  assert.ok(JSON.stringify(outbound(bot).lastCard()).includes("日志巡检"));
});

await t("/schedule 带自然语言时交给 CLI", async () => {
  const rt = await makeRuntime();
  const { session, msg } = await seedSession(rt);
  const { outcome } = await runCommand(rt, session, msg, "/schedule 每小时巡检一次");
  assert.equal(outcome, "continue");
});

await t("话题内不能切换执行引擎", async () => {
  const rt = await makeRuntime();
  const { session, msg } = await seedSession(rt);
  const br = rt.botRuntimes.get("developer");
  const outcome = await handleSessionCommand({
    runtime: rt, config: br.config, msg, bot: br.bot, session,
    cliAdapter: getCliAdapter(session.cliId),
    cliRequest: { cliId: "codex", prompt: "干活" }, isNew: false, hasThread: true,
  });
  assert.equal(outcome, "handled");
  assert.ok(outbound(br.bot).lastText().includes("请新开一个话题"));
});

// ─────────────────────────── 卡片回调 ───────────────────────────
console.log("卡片回调");

await t("停止任务：非发起人点不动，发起人可以停", async () => {
  const rt = await makeRuntime();
  const { session } = await seedSession(rt, { status: "active" });
  const controller = new AbortController();
  rt.activeRuns.set(session.id, { controller, ownerOpenId: "ou_owner" });
  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  const denied = await handle(cardAction({ action: "abort_task", sessionId: session.id }, { operatorOpenId: "ou_other" }));
  assert.equal(denied.toast.type, "warning");
  assert.equal(controller.signal.aborted, false);
  const ok = await handle(cardAction({ action: "abort_task", sessionId: session.id }));
  assert.equal(ok.toast.type, "success");
  assert.equal(controller.signal.aborted, true);
  const again = await handle(cardAction({ action: "abort_task", sessionId: session.id }));
  assert.equal(again.toast.content.includes("正在停止"), true);
});

/** 7 条记录 = 两页（每页 5 条），prompt 里的序号越大越新。 */
const seedTwoPages = async (rt) => {
  for (let i = 0; i < 7; i += 1) {
    await seedRecord(rt, {
      prompt: `任务 ${i}`,
      startedAt: `2026-08-24T02:0${i}:00.000Z`,
      finishedAt: `2026-08-24T02:0${i}:30.000Z`,
    });
  }
};

await t("历史翻页：点下一页原地换成第二页，不新发消息", async () => {
  const rt = await makeRuntime();
  const { session, msg } = await seedTwoPages(rt).then(() => seedSession(rt));
  const { bot } = await runCommand(rt, session, msg, "/history");
  const next = outbound(bot)
    .callbacks(outbound(bot).lastCard())
    .find((v) => v.action === "history_page" && v.page === 2);
  assert.ok(next, "第一页要有一个指向第二页的按钮");
  assert.equal(next.botId, "developer");
  assert.equal(next.chatId, "oc_test");

  const before = outbound(bot).all().length;
  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  const res = await handle(cardAction(next));
  const json = JSON.stringify(res.card.data);
  assert.ok(json.includes("任务 1") && json.includes("任务 0"), "第二页要是更早的那两条");
  assert.equal(json.includes("任务 6"), false, "第一页的内容不能留在第二页上");
  assert.ok(json.includes("第 2/2 页"), "卡片要说明当前在第几页");
  assert.equal(outbound(bot).all().length, before, "翻页只更新卡片，不能再发一条消息");
});

await t("历史翻页：第一页没有上一页，末页没有下一页", async () => {
  const rt = await makeRuntime();
  const { session, msg } = await seedTwoPages(rt).then(() => seedSession(rt));
  const { bot } = await runCommand(rt, session, msg, "/history");
  const first = JSON.stringify(outbound(bot).lastCard());
  assert.equal(first.includes("上一页"), false, "第一页点上一页没有内容可看");
  assert.ok(first.includes("下一页"));

  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  const res = await handle(cardAction({
    action: "history_page", botId: "developer", chatId: "oc_test", page: 2,
  }));
  const last = JSON.stringify(res.card.data);
  assert.ok(last.includes("上一页"), "第二页要能回到更近的记录");
  assert.equal(last.includes("下一页"), false, "末页点下一页没有内容可看");
});

await t("历史翻页：机器人或群不对时只给 toast，不渲染内容", async () => {
  const rt = await makeRuntime();
  await seedTwoPages(rt);
  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  const page1 = { action: "history_page", botId: "developer", chatId: "oc_test", page: 1 };

  // 卡片被转发到别的群：按钮里写的群和这次点击发生的位置不一致
  const forwarded = await handle(cardAction(page1, { chatId: "oc_another" }));
  assert.equal(forwarded.toast.type, "error");
  assert.equal(forwarded.card, undefined, "校验不过就不能把记录渲染出来");
  // 回调没带群 id 时校验不了来源，同样不渲染
  const unknownChat = await handle(cardAction(page1, { chatId: "" }));
  assert.equal(unknownChat.card, undefined);
  // 另一台机器人的历史卡片
  const otherBot = await handle(cardAction({ ...page1, botId: "reviewer" }));
  assert.equal(otherBot.toast.type, "error");
  assert.equal(otherBot.card, undefined);

  assert.equal(
    JSON.stringify([forwarded, unknownChat, otherBot]).includes("任务 3"),
    false,
    "被拒绝的翻页不能顺带把记录内容漏出去",
  );
});

await t("历史翻页：页码越界收敛到有效页，不报错", async () => {
  const rt = await makeRuntime();
  await seedTwoPages(rt);
  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  const over = await handle(cardAction({
    action: "history_page", botId: "developer", chatId: "oc_test", page: 99,
  }));
  assert.ok(over.card, "越界不能变成一张空白卡片或一句报错");
  assert.ok(JSON.stringify(over.card.data).includes("第 2/2 页"), "越界要收敛到末页");
  assert.equal(over.toast.type, "info", "要说清为什么不是点的那一页");

  // 记录被滚动清理干净后，第二页也不存在了，收敛到唯一的第 1 页空状态
  const emptyRt = await makeRuntime();
  const emptyHandle = createCardActionHandler({ runtime: emptyRt, config: BOTS[0] });
  const empty = await emptyHandle(cardAction({
    action: "history_page", botId: "developer", chatId: "oc_test", page: 2,
  }));
  assert.ok(JSON.stringify(empty.card.data).includes("还没有任务记录"));
});

/**
 * 10 条记录：成功 5 + 交接 1 + 等人 1 + 失败 2 + 已停止 1。
 * 「全部」和「成功」都不止一页，才能验出翻页和筛选组合起来还对。
 * 「等人」那条排在最新的几条里：万一它被错误地算进成功档，会直接出现在
 * 成功档第一页上——放在末尾的话，断言「它不在这一页」等于什么都没验。
 */
const MIXED_HISTORY = [
  { prompt: "任务 0 成功", status: "success" },
  { prompt: "任务 1 失败", status: "failed" },
  { prompt: "任务 2 成功", status: "success" },
  { prompt: "任务 3 已停止", status: "cancelled" },
  { prompt: "任务 4 成功", status: "success" },
  { prompt: "任务 5 交接", status: "forwarded" },
  { prompt: "任务 6 失败", status: "failed" },
  { prompt: "任务 7 成功", status: "success" },
  { prompt: "任务 8 等人", status: "waiting" },
  { prompt: "任务 9 成功", status: "success" },
];
const seedMixedHistory = async (rt) => {
  for (const [i, row] of MIXED_HISTORY.entries()) {
    await seedRecord(rt, {
      ...row,
      startedAt: `2026-08-24T02:0${i}:00.000Z`,
      finishedAt: `2026-08-24T02:0${i}:30.000Z`,
    });
  }
};
/** 从一张卡片上找出某个筛选档的按钮回调。 */
const filterCallback = (bot, card, filter) =>
  outbound(bot).callbacks(card).find((v) => v.action === "history_page" && v.filter === filter);

await t("历史筛选：切到「失败」后只剩失败记录，并且回到第一页", async () => {
  const rt = await makeRuntime();
  const { session, msg } = await seedMixedHistory(rt).then(() => seedSession(rt));
  const { bot } = await runCommand(rt, session, msg, "/history");
  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });

  // 先翻到第二页：筛选必须从「当前不在第一页」的状态下也能回到第一页
  const next = outbound(bot).callbacks(outbound(bot).lastCard())
    .find((v) => v.action === "history_page" && v.page === 2 && v.filter === "all");
  const second = await handle(cardAction(next));
  assert.ok(JSON.stringify(second.card.data).includes("第 2/2 页"), "先确认确实在第二页");

  const failed = filterCallback(bot, second.card.data, "failed");
  assert.ok(failed, "第二页上也要有筛选入口");
  assert.equal(failed.page, 1, "筛选按钮回带的页码就是第一页");
  const res = await handle(cardAction(failed));
  const json = JSON.stringify(res.card.data);

  assert.ok(json.includes("任务 1 失败") && json.includes("任务 6 失败"));
  for (const gone of ["任务 0 成功", "任务 5 交接", "任务 3 已停止", "任务 9 成功"]) {
    assert.equal(json.includes(gone), false, `${gone} 不该出现在失败档里`);
  }
  assert.ok(json.includes("第 1/1 页"), "切换筛选后要回到第一页");
  assert.ok(json.includes("筛选：失败"), "当前生效的筛选要在卡片上看得见");
  assert.equal(json.includes("下一页"), false, "失败档只有两条，不该还留着翻页按钮");
});

/**
 * 这条用例锁的是「成功档收哪些结局」这条线本身：
 * 收下做完之后把结果流转出去的（任务 5 交接），挡住停在半路等人拍板的（任务 8 等人），
 * 并且翻页之后这条线仍然成立。
 * 它是票据 04 那条「成功一档收下交接的任务」的后继：当时 handoff 一个取值同时表示
 * 这两种结局，用例只能整档收下，于是把「等人拍板」也算成了已完成。
 */
await t("历史筛选：成功档收下「做完后流转」，挡住「停下来等人」", async () => {
  const rt = await makeRuntime();
  const { session, msg } = await seedMixedHistory(rt).then(() => seedSession(rt));
  const { bot } = await runCommand(rt, session, msg, "/history");
  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });

  const first = await handle(cardAction(filterCallback(bot, outbound(bot).lastCard(), "success")));
  const firstJson = JSON.stringify(first.card.data);
  // 交接是「完成之后把结果交出去」，复盘时属于成功，不该单成一档让人找不到
  assert.ok(firstJson.includes("任务 5 交接"), "交接的任务要归进成功档");
  // 任务 8 比任务 5 还新：真被算进成功档的话，它就在这一页的最上面几行
  assert.equal(firstJson.includes("任务 8 等人"), false,
    "还等着用户拍板的任务出现在成功档里，等于告诉他这件事已经不用管了");
  assert.equal(firstJson.includes("任务 1 失败"), false);
  assert.ok(firstJson.includes("第 1/2 页"), "成功档 6 条（成功 5 + 交接 1），正好两页");

  const next = outbound(bot).callbacks(first.card.data)
    .find((v) => v.action === "history_page" && v.page === 2);
  assert.equal(next.filter, "success", "翻页按钮必须把当前筛选带上，否则翻一页就回到全部");
  const second = await handle(cardAction(next));
  const secondJson = JSON.stringify(second.card.data);
  assert.ok(secondJson.includes("任务 0 成功"));
  for (const gone of ["任务 8 等人", "任务 3 已停止"]) {
    assert.equal(secondJson.includes(gone), false, `翻页后仍然只有成功档的记录，${gone} 不该在`);
  }
  assert.ok(secondJson.includes("筛选：成功") && secondJson.includes("第 2/2 页"));
});

await t("历史筛选：等人拍板的任务在「全部」档看得见，说法也不是已完成", async () => {
  const rt = await makeRuntime();
  const { session, msg } = await seedMixedHistory(rt).then(() => seedSession(rt));
  const { bot } = await runCommand(rt, session, msg, "/history");
  // 不进任何一档 ≠ 从历史里消失：它必须在「全部」的第一页上原样列着
  const json = JSON.stringify(outbound(bot).lastCard());
  assert.ok(json.includes("筛选：全部") && json.includes("共 10 条"), "全部档一条都不能少");
  assert.ok(json.includes("等待确认 任务 8 等人"), "等人拍板的记录要能在全部档里看到，且说法要对");
  assert.equal(json.includes("已完成 任务 8 等人"), false, "没做完的任务不能说成已完成");

  // 详情里要说清它停在哪儿，否则和一次没留下答案的正常执行长得一模一样
  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  const waiting = rt.taskRecords.list().find((r) => r.prompt.includes("任务 8 等人"));
  const detail = outbound(bot).callbacks(outbound(bot).lastCard())
    .find((v) => v.action === "history_detail" && v.recordId === waiting.id);
  assert.ok(detail, "全部档的这一行上要有它自己的详情入口");
  const card = (await handle(cardAction(detail))).card.data;
  assert.ok(JSON.stringify(card).includes("停在了等人拍板那一步"));
  assert.notEqual(card.header.template, "green", "没做完的任务不该顶着一张绿卡片");
});

await t("历史筛选：这一档为空说的是筛没了，不是本群没有历史", async () => {
  const rt = await makeRuntime();
  const { session, msg } = await seedSession(rt);
  await seedRecord(rt, { prompt: "唯一一条成功任务" });
  const { bot } = await runCommand(rt, session, msg, "/history");
  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });

  const res = await handle(cardAction(filterCallback(bot, outbound(bot).lastCard(), "cancelled")));
  const json = JSON.stringify(res.card.data);
  assert.ok(json.includes("没有「已停止」的任务记录"), "要说清是哪一档为空");
  assert.equal(json.includes("还没有任务记录"), false, "本群其实有历史，不能说成一条都没有");
  assert.ok(json.includes("共有 1 条历史"), "要告诉用户本群还有多少条");
  assert.equal(json.includes("唯一一条成功任务"), false, "筛掉的记录不能还留在卡片上");

  // 按钮里塞一个不存在的筛选档：收敛成「全部」，不是报错也不是空列表
  const bogus = await handle(cardAction({
    action: "history_page", botId: "developer", chatId: "oc_test", page: 1, filter: "怎么会有这一档",
  }));
  const bogusJson = JSON.stringify(bogus.card.data);
  assert.ok(bogusJson.includes("筛选：全部"));
  assert.ok(bogusJson.includes("唯一一条成功任务"));
});

await t("历史详情：点详情原地换成详情卡，完整答案和失败原因都在", async () => {
  const rt = await makeRuntime();
  const { session, msg } = await seedSession(rt);
  const failed = await seedRecord(rt, {
    prompt: "跑一下回归测试", status: "failed", answer: "",
    failureReason: "Error: exit code 1\n  at runner.ts:88",
    threadId: "omt_regression", workspaceDir: "/srv/demo",
    turns: 3, totalTokens: 9_000, toolCount: 5, completedToolCount: 4,
  });
  // 3780 字 + 尾部哨兵：贴着落盘上限但没超。卡片层另有 900 字的摘要预览，
  // 展示层若误用它，哨兵就会消失——而这条用例的名字正是「完整答案」。
  const longAnswer = "已经更新完毕，一共改了两处。".repeat(270) + "【answer-tail】";
  const done = await seedRecord(rt, {
    prompt: "更新 README", answer: longAnswer,
    startedAt: "2026-08-24T03:00:00.000Z", finishedAt: "2026-08-24T03:00:20.000Z",
  });
  const { bot } = await runCommand(rt, session, msg, "/history");
  const details = outbound(bot).callbacks(outbound(bot).lastCard())
    .filter((v) => v.action === "history_detail");
  assert.equal(details.length, 2, "列表上每一条记录都要有自己的详情入口");

  const before = outbound(bot).all().length;
  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  const res = await handle(cardAction(details.find((v) => v.recordId === failed.id)));
  const json = JSON.stringify(res.card.data);
  assert.ok(json.includes("exit code 1"), "失败原因要能在详情里看到，不用再回话题翻当时那张卡片");
  assert.ok(json.includes("omt_regression"), "要能看出该回哪个话题去追问");
  assert.ok(json.includes("/srv/demo"), "要能看出改的是哪份代码");
  assert.ok(json.includes("轮次 3") && json.includes("工具 4/5") && json.includes("耗时"));
  assert.equal(json.includes("更新 README"), false, "详情卡上只该有点开的那一条记录");
  assert.equal(outbound(bot).all().length, before, "详情只更新卡片，不能再发一条消息");

  const ok = await handle(cardAction(details.find((v) => v.recordId === done.id)));
  const okJson = JSON.stringify(ok.card.data);
  assert.ok(okJson.includes("【answer-tail】"), "详情给的是完整答案，展示层不能再套一层预览");
  assert.equal(okJson.includes("_答案过长"), false, "没触发落盘截断就不该出现截断提示");
});

await t("历史详情：在别的话题打开截断记录，指路指向记录自己的话题", async () => {
  const rt = await makeRuntime();
  // 记录产生在 A 话题，答案长到被落盘截断
  const truncated = await seedRecord(rt, {
    prompt: "整理一份长报告", threadId: "omt_report_home",
    answer: "报".repeat(TASK_ANSWER_LIMIT + 200),
  });
  // /history 跨话题：用户在同一个群的 B 话题里翻历史
  const { session, msg } = await seedSession(rt, { threadId: "omt_elsewhere" });
  const { bot } = await runCommand(rt, session, msg, "/history");
  const detail = outbound(bot).callbacks(outbound(bot).lastCard())
    .find((v) => v.action === "history_detail" && v.recordId === truncated.id);
  assert.ok(detail, "别的话题里也要能看到这条记录，/history 本来就是跨话题的");

  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  const json = JSON.stringify((await handle(cardAction(detail))).card.data);
  assert.ok(json.includes(`前 ${TASK_ANSWER_LIMIT} 字`), "先确认这条确实被截断了");
  assert.ok(json.includes("omt_report_home"), "指路要指向记录所属的话题");
  assert.equal(
    json.includes("本话题"), false,
    "当前是 omt_elsewhere，说「本话题」会把人指到一个没有那张任务卡片的地方",
  );
});

await t("历史详情：返回列表回到点开详情前的那一页和那个筛选", async () => {
  const rt = await makeRuntime();
  const { session, msg } = await seedMixedHistory(rt).then(() => seedSession(rt));
  const { bot } = await runCommand(rt, session, msg, "/history");
  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });

  // 先切到「成功」档，再翻到第二页：返回列表必须把页码和筛选一起还原，少一个都算丢了进度
  const successCard = (await handle(cardAction(
    filterCallback(bot, outbound(bot).lastCard(), "success")))).card.data;
  const next = outbound(bot).callbacks(successCard)
    .find((v) => v.action === "history_page" && v.page === 2);
  const second = (await handle(cardAction(next))).card.data;
  assert.ok(JSON.stringify(second).includes("第 2/2 页"), "先确认确实停在成功档的第二页");

  const detail = outbound(bot).callbacks(second).find((v) => v.action === "history_detail");
  assert.equal(detail.page, 2, "详情按钮要记住用户是从哪一页点进来的");
  assert.equal(detail.filter, "success");
  const detailCard = (await handle(cardAction(detail))).card.data;

  const back = outbound(bot).callbacks(detailCard).find((v) => v.action === "history_page");
  assert.ok(back, "详情卡上要有回到列表的入口");
  const list = await handle(cardAction(back));
  const json = JSON.stringify(list.card.data);
  assert.ok(json.includes("筛选：成功"), "返回列表不能把筛选丢了");
  assert.ok(json.includes("第 2/2 页"), "返回列表要回到刚才那一页，不是第一页");
  assert.equal(list.toast, undefined, "页码仍然有效，不该弹「这一页已经不存在」");
});

await t("历史详情：记录被滚动挤掉后只给 toast，卡片保持不变", async () => {
  const rt = await makeRuntime();
  // 真的让它被挤出去：容量设成 2，随后追加的两条会把最早那条挤出保留范围
  rt.taskRecords = await JsonTaskRecordStore.open(join(dir, "detail-roll.json"), 2);
  const oldest = await seedRecord(rt, { prompt: "最早的那条任务" });
  const { session, msg } = await seedSession(rt);
  const { bot } = await runCommand(rt, session, msg, "/history");
  const detail = outbound(bot).callbacks(outbound(bot).lastCard())
    .find((v) => v.action === "history_detail" && v.recordId === oldest.id);
  assert.ok(detail, "先确认这条记录当时确实在列表上");

  await seedRecord(rt, { prompt: "新任务甲" });
  await seedRecord(rt, { prompt: "新任务乙" });
  assert.equal(rt.taskRecords.list().some((r) => r.id === oldest.id), false, "确认它真的被挤掉了");

  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  const gone = await handle(cardAction(detail));
  assert.equal(gone.card, undefined, "卡片保持不变，用户手上那张列表不该被一张报错卡片顶掉");
  assert.ok(gone.toast.content.includes("不在保留范围"), "要说清为什么看不到");
  assert.notEqual(gone.toast.type, "error", "记录到期是正常结局，不是错误");

  // 还留着的记录照常能看：别把「这一条查不到」做成「详情全都打不开」
  const alive = await handle(cardAction({
    ...detail, recordId: rt.taskRecords.list().at(-1).id,
  }));
  assert.ok(JSON.stringify(alive.card.data).includes("新任务乙"));
});

await t("历史详情：机器人或群不对时只给 toast，别的群的记录读不出来", async () => {
  const rt = await makeRuntime();
  const secret = await seedRecord(rt, { prompt: "本群的机密任务", answer: "机密答案" });
  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  const value = {
    action: "history_detail", botId: "developer", chatId: "oc_test",
    recordId: secret.id, page: 1, filter: "all",
  };

  // 卡片被转发到别的群之后点开：按钮里写的群和这次点击发生的位置不一致
  const forwarded = await handle(cardAction(value, { chatId: "oc_another" }));
  assert.equal(forwarded.toast.type, "error");
  assert.equal(forwarded.card, undefined, "校验不过就不能把记录渲染出来");
  // 回调没带群 id 时校验不了来源，同样不渲染
  const unknownChat = await handle(cardAction(value, { chatId: "" }));
  assert.equal(unknownChat.card, undefined);
  // 另一台机器人的历史卡片
  const otherBot = await handle(cardAction({ ...value, botId: "reviewer" }));
  assert.equal(otherBot.toast.type, "error");
  assert.equal(otherBot.card, undefined);

  // 最要命的一种：在本群点击、作用域字段都对，但塞进来的 id 属于别的群。
  // 只靠回调侧那道校验挡不住它，取数本身必须也带作用域。
  const elsewhere = await seedRecord(rt, {
    prompt: "另一个群的任务", answer: "机密答案", chatId: "oc_another",
  });
  const stolen = await handle(cardAction({ ...value, recordId: elsewhere.id }));
  assert.equal(stolen.card, undefined, "记录不属于本群，在本群点击也不能渲染");

  assert.equal(
    JSON.stringify([forwarded, unknownChat, otherBot, stolen]).includes("机密"),
    false,
    "被拒绝的详情不能顺带把记录内容漏出去",
  );
});

await t("产品方案确认：非发起人被拒、确认一次、重复点击幂等", async () => {
  const rt = await makeRuntime();
  const { session } = await seedSession(rt);
  const request = ProductSpecRequestSchema.parse({
    title: "用户详情", summary: "s", deliveryMode: "lark-doc",
    documentUrl: "https://x.feishu.cn/docx/TOKEN9",
  });
  const flow = rt.productSpecFlows.create({
    taskId: "t1", botId: "developer", sessionId: session.id,
    ownerOpenId: "ou_owner", ownerUnionId: "on_owner", request,
  });
  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  const denied = await handle(cardAction({ action: "approve_product_spec", flowToken: flow.token },
    { operatorOpenId: "ou_other", operatorUnionId: "on_other" }));
  assert.equal(denied.toast.type, "warning");
  assert.equal(rt.productSpecFlows.get(flow.token).status, "pending");

  const ok = await handle(cardAction({ action: "approve_product_spec", flowToken: flow.token }));
  assert.equal(ok.toast.type, "success");
  assert.ok(JSON.stringify(ok.card.data).includes("产品方案已确认"));

  const again = await handle(cardAction({ action: "approve_product_spec", flowToken: flow.token }));
  assert.equal(again.toast.type, "info");
  assert.equal(rt.productSpecFlows.get(flow.token).approvedAt, ok.card.data ? rt.productSpecFlows.get(flow.token).approvedAt : null);
});

await t("旧的产品方案卡片会显示已失效", async () => {
  const rt = await makeRuntime();
  const { session } = await seedSession(rt);
  const request = ProductSpecRequestSchema.parse({
    title: "t", summary: "s", deliveryMode: "lark-doc", documentUrl: "https://x.feishu.cn/docx/T1",
  });
  const base = { taskId: "t1", botId: "developer", sessionId: session.id, ownerOpenId: "ou_owner", request };
  const old = rt.productSpecFlows.create(base);
  rt.productSpecFlows.create(base);
  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  const res = await handle(cardAction({ action: "approve_product_spec", flowToken: old.token }));
  assert.equal(res.toast.type, "warning");
  assert.ok(JSON.stringify(res.card.data).includes("已失效"));
});

await t("审批：非发起人不能拍板", async () => {
  const rt = await makeRuntime();
  const { session } = await seedSession(rt);
  const request = ApprovalRequestSchema.parse({ title: "重启服务", summary: "s", impact: "全站", risk: "high" });
  const flow = rt.approvalFlows.create({
    taskId: "t", botId: "developer", sessionId: session.id,
    ownerOpenId: "ou_owner", ownerUnionId: "on_owner",
    originalMessageId: "om", replyInThread: true, request,
  });
  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  const res = await handle(cardAction({ action: "decide_approval", flowToken: flow.token, decision: "approved" },
    { operatorOpenId: "ou_other", operatorUnionId: "on_other" }));
  assert.equal(res.toast.type, "warning");
  assert.equal(rt.approvalFlows.get(flow.token).status, "pending", "被拒绝的点击不应改写状态");
});

await t("审批：会话正忙时保持 pending，可以稍后重试", async () => {
  const rt = await makeRuntime();
  const { session } = await seedSession(rt, { status: "active" });
  const request = ApprovalRequestSchema.parse({ title: "删数据", summary: "s", impact: "i", risk: "high" });
  const flow = rt.approvalFlows.create({
    taskId: "t", botId: "developer", sessionId: session.id,
    ownerOpenId: "ou_owner", originalMessageId: "om", replyInThread: true, request,
  });
  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  const res = await handle(cardAction({ action: "decide_approval", flowToken: flow.token, decision: "approved" }));
  assert.equal(res.toast.type, "warning");
  assert.equal(rt.approvalFlows.get(flow.token).status, "pending", "结论不能在会话接不住时就落死");
  assert.equal(res.card, undefined, "不该把卡片换成已决定态");
});

await t("澄清：逐题推进，非最后一题不需要会话空闲", async () => {
  const rt = await makeRuntime();
  const { session } = await seedSession(rt, { status: "active" });
  const request = ClarificationRequestSchema.parse({
    title: "确认范围",
    questions: [
      { id: "a", prompt: "从哪进入？", options: [{ id: "x", label: "列表" }, { id: "y", label: "菜单" }], recommendedOptionId: "y" },
      { id: "b", prompt: "展示哪些字段？", options: [{ id: "p", label: "基础" }, { id: "q", label: "全量" }] },
    ],
  });
  const flow = rt.clarificationFlows.create({
    taskId: "t", botId: "developer", sessionId: session.id,
    ownerOpenId: "ou_owner", ownerUnionId: "on_owner",
    originalMessageId: "om", replyInThread: true, request,
  });
  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  const res = await handle(cardAction({ action: "answer_clarification", flowToken: flow.token, questionId: "a", optionId: "x" }));
  assert.equal(res.toast.type, "success");
  assert.equal(rt.clarificationFlows.get(flow.token).answers.length, 1);
  assert.ok(JSON.stringify(res.card.data).includes("展示哪些字段"), "没有推进到第二题");
  assert.ok(JSON.stringify(res.card.data).includes("已确认 1 项"));
});

await t("澄清：最后一题在会话忙时不落答案（卡片不会被卡死）", async () => {
  const rt = await makeRuntime();
  const { session } = await seedSession(rt, { status: "active" });
  const request = ClarificationRequestSchema.parse({
    title: "确认", questions: [{ id: "a", prompt: "?", options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] }],
  });
  const flow = rt.clarificationFlows.create({
    taskId: "t", botId: "developer", sessionId: session.id,
    ownerOpenId: "ou_owner", originalMessageId: "om", replyInThread: true, request,
  });
  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  const res = await handle(cardAction({ action: "answer_clarification", flowToken: flow.token, questionId: "a", optionId: "x" }));
  assert.equal(res.toast.type, "warning");
  assert.equal(rt.clarificationFlows.get(flow.token).answers.length, 0, "答案不该在会话接不住时就落库");
  assert.equal(rt.clarificationFlows.get(flow.token).currentIndex, 0);
});

await t("澄清：自定义答案为空时给出提示而不是记空值", async () => {
  const rt = await makeRuntime();
  const { session } = await seedSession(rt, { status: "active" });
  const request = ClarificationRequestSchema.parse({
    title: "确认", questions: [
      { id: "a", prompt: "?", options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] },
      { id: "b", prompt: "?", options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] },
    ],
  });
  const flow = rt.clarificationFlows.create({
    taskId: "t", botId: "developer", sessionId: session.id,
    ownerOpenId: "ou_owner", originalMessageId: "om", replyInThread: true, request,
  });
  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  const res = await handle(cardAction(
    { action: "answer_clarification", flowToken: flow.token, questionId: "a", custom: true },
    { formValue: { custom_answer: "   " } }));
  assert.equal(res.toast.type, "warning");
  assert.equal(rt.clarificationFlows.get(flow.token).answers.length, 0);
});

await t("澄清：问题已推进时旧按钮不生效", async () => {
  const rt = await makeRuntime();
  const { session } = await seedSession(rt, { status: "active" });
  const request = ClarificationRequestSchema.parse({
    title: "确认", questions: [
      { id: "a", prompt: "?", options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] },
      { id: "b", prompt: "?", options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] },
    ],
  });
  const flow = rt.clarificationFlows.create({
    taskId: "t", botId: "developer", sessionId: session.id,
    ownerOpenId: "ou_owner", originalMessageId: "om", replyInThread: true, request,
  });
  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  await handle(cardAction({ action: "answer_clarification", flowToken: flow.token, questionId: "a", optionId: "x" }));
  const stale = await handle(cardAction({ action: "answer_clarification", flowToken: flow.token, questionId: "a", optionId: "y" }));
  assert.equal(stale.toast.type, "warning");
  assert.equal(rt.clarificationFlows.get(flow.token).answers.length, 1);
});

await t("跨 bot 的卡片回调一律拒绝", async () => {
  const rt = await makeRuntime();
  const { session } = await seedSession(rt);
  const request = ApprovalRequestSchema.parse({ title: "t", summary: "s", impact: "i", risk: "low" });
  const flow = rt.approvalFlows.create({
    taskId: "t", botId: "developer", sessionId: session.id,
    ownerOpenId: "ou_owner", originalMessageId: "om", replyInThread: true, request,
  });
  // 用 reviewer 的身份去处理 developer 的审批
  const handle = createCardActionHandler({ runtime: rt, config: BOTS[1] });
  const res = await handle(cardAction({ action: "decide_approval", flowToken: flow.token, decision: "approved" }));
  assert.equal(res.toast.type, "error");
  assert.equal(rt.approvalFlows.get(flow.token).status, "pending");
});

await t("未知回调返回 undefined，不误吞其他 bot 的事件", async () => {
  const rt = await makeRuntime();
  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  assert.equal(await handle(cardAction({ action: "something_else" })), undefined);
});


// ─────────────────────────── 飞书入站解析 ───────────────────────────
console.log("飞书入站");

const LARK = await R("im/lark.js");
const MP = await R("im/message-parser.js");

await t("群聊 @机器人 的真实事件：双层 JSON + post 富文本 + 占位符", () => {
  // 这是飞书真实投递的形状：外层事件已被 SDK 解析，content 仍是 JSON 字符串
  const content = JSON.stringify({
    content: [[
      { tag: "at", user_id: "ou_bot", user_name: "开发助手" },
      { tag: "text", text: " 帮我看看这个报错" },
      { tag: "code_block", text: "TypeError: x is not a function" },
    ], [
      { tag: "img", image_key: "img_v3_abc" },
    ]],
  });
  const text = MP.extractMessageText("post", content);
  assert.ok(text.includes("帮我看看这个报错"));
  assert.ok(text.includes("TypeError"), "代码块内容被吞掉了");
  const resources = MP.extractResourceKeys("post", content);
  assert.deepEqual(resources, [{ type: "image", key: "img_v3_abc" }]);
});

await t("一句话 @两个人：占位符全部还原", () => {
  const mentions = MP.parseMentions([
    { key: "@_user_1", name: "开发助手", id: { open_id: "ou_dev" } },
    { key: "@_user_2", name: "审查助手", id: { open_id: "ou_rev" } },
  ]);
  const resolved = MP.resolveMentions("@_user_1 改完了，请 @_user_2 看一下", mentions);
  assert.equal(resolved, "@开发助手 改完了，请 @审查助手 看一下");
  assert.equal(mentions[1].openId, "ou_rev");
});

await t("mentions 字段缺失或残缺不会抛错", () => {
  assert.deepEqual(MP.parseMentions(undefined), []);
  assert.deepEqual(MP.parseMentions([]), []);
  const partial = MP.parseMentions([{ key: "@_user_1" }]);
  assert.deepEqual(partial, [{ key: "@_user_1", name: "", openId: "" }]);
  // 没有 key 的条目不能把正文里的内容误替换掉
  assert.equal(MP.resolveMentions("原文不变", MP.parseMentions([{ name: "x" }])), "原文不变");
});

await t("卡片回调取操作人身份，不信按钮自带的用户信息", () => {
  const action = LARK.parseCardAction({
    operator: { open_id: "ou_real", union_id: "on_real" },
    context: { open_message_id: "om_card" },
    action: {
      value: { action: "decide_approval", flowToken: "tok", operatorOpenId: "ou_forged" },
      form_value: { custom_answer: "我的意见" },
    },
  });
  assert.equal(action.operatorOpenId, "ou_real");
  assert.equal(action.operatorUnionId, "on_real");
  assert.equal(action.messageId, "om_card");
  assert.equal(action.formValue.custom_answer, "我的意见");
  // 按钮里伪造的身份只是普通数据，不会成为 operator
  assert.notEqual(action.operatorOpenId, action.value.operatorOpenId);
});

await t("卡片回调带回这次点击所在的群，作用域校验靠它", () => {
  const action = LARK.parseCardAction({
    operator: { open_id: "ou_real" },
    context: { open_message_id: "om_card", open_chat_id: "oc_here" },
    action: { value: { action: "history_page", chatId: "oc_elsewhere", page: 2 } },
  });
  // 群 id 和 open_message_id 挂在同一层（context）下
  assert.equal(action.chatId, "oc_here");
  assert.notEqual(action.chatId, action.value.chatId, "按钮里写的群只是数据，不是回调位置");
  // 顶层写法作为兜底
  assert.equal(LARK.parseCardAction({ open_chat_id: "oc_top" }).chatId, "oc_top");
  assert.equal(LARK.parseCardAction({}).chatId, "");
});

await t("卡片回调对残缺载荷是安全的", () => {
  const empty = LARK.parseCardAction({});
  assert.deepEqual(empty.value, {});
  assert.deepEqual(empty.formValue, {});
  assert.equal(empty.operatorOpenId, "");
  // value 是字符串等非对象时不能污染下游
  assert.deepEqual(LARK.parseCardAction({ action: { value: "oops" } }).value, {});
  assert.deepEqual(LARK.parseCardAction(null).value, {});
});

await t("@提及消息体是飞书要求的带语言节点二维数组", () => {
  const content = LARK.buildMentionPostContent({ openId: "ou_x", name: "开发助手" }, "任务已完成");
  assert.ok(content.zh_cn, "缺少语言节点，接口会直接报错");
  const [paragraph] = content.zh_cn.content;
  assert.equal(paragraph[0].tag, "at");
  assert.equal(paragraph[0].user_id, "ou_x");
  assert.ok(paragraph[1].text.includes("任务已完成"));
});

await t("超长文本被截断到接口上限并给出说明", () => {
  const long = "字".repeat(9000);
  const fitted = LARK.fitFeishuText(long);
  assert.ok(fitted.length <= LARK.FEISHU_TEXT_LIMIT);
  assert.ok(fitted.includes("已截断"));
  // 评论接口上限更低
  assert.ok(LARK.fitFeishuText(long, LARK.FEISHU_COMMENT_LIMIT).length <= LARK.FEISHU_COMMENT_LIMIT);
  // 正常长度不动它
  assert.equal(LARK.fitFeishuText("短文本"), "短文本");
});

await t("@提及消息里的长文本也会被截断", () => {
  const content = LARK.buildMentionPostContent({ openId: "ou_x", name: "n" }, "字".repeat(9000));
  assert.ok(content.zh_cn.content[0][1].text.length <= LARK.FEISHU_TEXT_LIMIT + 1);
});

// ─────────────────────────── 会话路由 ───────────────────────────
console.log("会话路由");

await t("同话题的追问复用会话，新话题拿到新会话", async () => {
  const rt = await makeRuntime();
  const first = userMessage("实现登录", { threadId: "omt_a", messageId: "om_root" });
  const a = await rt.sessions.resolve(first, "claude", "developer", process.cwd());
  // 追问：threadId 相同，rootId 指向根消息
  const followUp = userMessage("再加个验证码", { threadId: "omt_a", rootId: "om_root", messageId: "om_2" });
  const b = await rt.sessions.resolve(followUp, "claude", "developer", process.cwd());
  assert.equal(b.isNew, false);
  assert.equal(b.session.id, a.session.id);
  const other = userMessage("另一件事", { threadId: "omt_b" });
  const c = await rt.sessions.resolve(other, "claude", "developer", process.cwd());
  assert.equal(c.isNew, true);
  assert.notEqual(c.session.id, a.session.id);
});

await t("普通群（无 threadId/rootId）用消息自身开一条任务线", async () => {
  const rt = await makeRuntime();
  const msg = userMessage("你好", { threadId: "", rootId: "", messageId: "om_solo" });
  const { session } = await rt.sessions.resolve(msg, "claude", "developer", process.cwd());
  assert.equal(session.threadId, "om_solo");
});

await t("同一话题里两台 bot 各自独立，互不串线", async () => {
  const rt = await makeRuntime();
  const msg = userMessage("看一下", { threadId: "omt_shared" });
  const dev = await rt.sessions.resolve(msg, "claude", "developer", process.cwd());
  const rev = await rt.sessions.resolve(msg, "codex", "reviewer", process.cwd());
  assert.notEqual(dev.session.id, rev.session.id);
  assert.equal(dev.session.cliId, "claude");
  assert.equal(rev.session.cliId, "codex");
  // 一方绑定 CLI 会话不影响另一方
  await rt.sessions.setCliSessionId(dev.session.id, "cli-dev");
  assert.equal(rt.sessions.get(rev.session.id).cliSessionId, undefined);
});


// ─────────────────────────── 进程树终止 ───────────────────────────
console.log("进程树终止（约 8 秒）");

await t("忽略 SIGTERM 的孙进程会被 SIGKILL 升级清理", async () => {
  const { spawnCli, killCli } = await R("cli/spawn-cli.js");
  // 直接子进程正常响应 SIGTERM；孙进程装死。真实场景是 Agent 起的 dev server。
  const script = `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);console.log('G '+process.pid)"], { stdio: "inherit" });
    setInterval(() => {}, 1000);
  `;
  const child = spawnCli(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
  let grandPid = null;
  child.stdout.on("data", (c) => {
    const m = /G (\d+)/.exec(c.toString());
    if (m) grandPid = Number(m[1]);
  });
  // 两次 node 冷启动，机器忙时轻松超过 1 秒——固定 sleep 会把用例自身抖红，
  // 而且抖红时下面的 killCli 根本执行不到，进程树会漏在系统里。所以改成轮询等。
  for (let i = 0; i < 100 && !grandPid; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!grandPid) { try { child.kill("SIGKILL"); } catch {} }
  assert.ok(grandPid, "孙进程没有起来，用例本身失效");
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.equal(alive(grandPid), true);

  killCli(child);
  await new Promise((r) => setTimeout(r, 1000));
  // 直接子进程此时已退出，signalCode 非空——升级判据不能依赖它
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  await new Promise((r) => setTimeout(r, 6000));
  const survived = alive(grandPid);
  if (survived) { try { process.kill(grandPid, "SIGKILL"); } catch {} }
  assert.equal(survived, false, "SIGKILL 升级没有触发，孙进程会永远握着引擎的 stdout");
});


// ─────────────────────────── 消息路由（两轮评审反复命中的那块） ───────────────────────────
console.log("消息路由");

const { createMessageHandler } = await R("app/message-router.js");

const DONE = [
  { type: "session", sessionId: "fake-cli-1" },
  { type: "result", answer: "做完了", sessionId: "fake-cli-1" },
];

/** 装配一个可驱动的 bot：把假引擎接进 runtime，返回 handler 与出站记录。 */
async function wire(events = DONE, { botId = "developer", adapterOptions = {} } = {}) {
  const rt = await makeRuntime();
  const adapter = createFakeAdapter(events, adapterOptions);
  rt.getAdapter = () => adapter;
  const br = rt.botRuntimes.get(botId);
  const handle = createMessageHandler({ runtime: rt, config: br.config });
  return { rt, adapter, br, handle, out: outbound(br.bot) };
}

const idle = (rt) => rt.activeRuns.size === 0;

await t("普通消息跑完一轮：卡片走到绿色，会话回到空闲", async () => {
  const { rt, handle, br, out } = await wire();
  const msg = userMessage("@开发助手 看一下项目", { threadId: "omt_r1" });
  await handle(msg, br.bot);
  await waitFor(() => idle(rt), { label: "任务收尾" });
  const final = out.lastUpdate();
  assert.ok(final, "没有终态卡片");
  assert.equal(final.header.template, "green");
  assert.ok(JSON.stringify(final).includes("做完了"));
  const session = [...rt.sessions["sessions"] ?? []].length ? null : null;
  assert.equal(rt.activeRuns.size, 0);
});

await t("@ 后面不打空格、输入法又在斜杠后插了空格，仍然认成命令", async () => {
  // 真机上踩到的原文：`@agent-os/ history`。text 里提及是 @_user_N 占位符，
  // 中文输入法在斜杠后自动补了一个空格。当时它被当成普通任务派给了引擎，
  // 引擎反问一句，于是用户只看到「/history 没反应」。
  const { rt, handle, br, adapter, out } = await wire();
  await seedRecord(rt, { prompt: "昨天那个改动" });
  const msg = userMessage("@_user_1/ history", {
    threadId: "omt_hist_ime",
    mentions: [{ key: "@_user_1", openId: "ou_developer", name: "开发助手" }],
  });
  await handle(msg, br.bot);

  assert.equal(adapter.prompts.length, 0, "这是命令，不该顺带跑一次 CLI");
  assert.equal(rt.activeRuns.size, 0);
  assert.ok(JSON.stringify(out.lastCard()).includes("昨天那个改动"), "该出历史卡片");
});

/** 建一条属于 developer / oc_test 的定时任务，用来驱动卡片按钮。 */
const seedSchedule = async (rt, over = {}) =>
  rt.schedules.create({
    botId: "developer", chatId: "oc_test", name: "日志巡检",
    cron: "0 9 * * *", prompt: "巡检一次", workspaceDir: process.cwd(), ...over,
  });

/** 从一张卡片里挖出所有回调按钮的 value——按钮怎么带参数，就怎么点回去。 */
const cardValues = (card) => {
  const found = [];
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    if (n.type === "callback" && n.value) found.push(n.value);
    Object.values(n).forEach(walk);
  };
  walk(card);
  return found;
};

await t("定时任务卡片：停用按钮带着目标状态，重复点也不会反弹回启用", async () => {
  const rt = await makeRuntime();
  const created = await seedSchedule(rt);
  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  // 从 /schedule 真实渲染出来的卡片里取按钮，不手工拼一个——
  // 手工拼的话，「按钮到底带没带目标状态」这条性质就绕过去了
  const { session, msg } = await seedSession(rt);
  const { bot } = await runCommand(rt, session, msg, "/schedule");
  const stop = cardValues(outbound(bot).lastCard()).find((v) => v.action === "schedule_toggle");
  assert.equal(stop.enabled, false, "写着「停用」的按钮，必须把目标状态 false 带回去");

  const res = await handle(cardAction(stop));
  assert.equal(rt.schedules.get(created.id).enabled, false);
  assert.ok(res.toast?.content.includes("已停用"));

  // 关键：拿同一份 payload 再点一次（等同于点群里那张过期的旧卡）。
  // 若回调侧是对当前值取反，这一下会把任务重新启用。
  const again = await handle(cardAction(stop));
  assert.equal(rt.schedules.get(created.id).enabled, false,
    "旧卡上写着「停用」的按钮，再点一次也只能是停用，不能反弹成启用");
  assert.ok(again.toast?.content.includes("已停用"), "回执也要和按钮上的字一致");

  // 反方向：刷新后的卡片该给「启用」，点了要真启用，文案也要对
  const start = cardValues(res.card.data).find((v) => v.action === "schedule_toggle");
  assert.equal(start.enabled, true, "停用之后，按钮该带着「启用」的目标状态");
  const back = await handle(cardAction(start));
  assert.equal(rt.schedules.get(created.id).enabled, true);
  assert.ok(back.toast?.content.includes("已启用"));
  assert.ok(JSON.stringify(back.card.data).includes("停用"), "刷新后的卡片要给回「停用」");
});

await t("定时任务卡片：删除两步，且第二步只能由点开确认的那个人来点", async () => {
  const rt = await makeRuntime();
  const created = await seedSchedule(rt);
  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  const base = { botId: "developer", chatId: "oc_test", scheduleId: created.id };

  const first = await handle(cardAction({ action: "schedule_delete", ...base },
    { operatorOpenId: "ou_jia" }));
  assert.equal(rt.schedules.list().length, 1, "第一次点只是要确认，不能真删");
  const confirm = cardValues(first.card.data).find((v) => v.confirmed === true);
  assert.ok(confirm, "该出现「确认删除」按钮");
  assert.equal(confirm.armedBy, "ou_jia", "确认按钮要记住是谁点开的");

  // 乙拿着甲点开的确认按钮点下去：卡片是群里共享的，不绑人的话对乙就是一点就删
  const byOther = await handle(cardAction(confirm, { operatorOpenId: "ou_yi" }));
  assert.equal(rt.schedules.list().length, 1, "别人不能替他完成第二步");
  assert.equal(byOther.toast?.type, "warning");

  // 甲自己点才算数
  const done = await handle(cardAction(confirm, { operatorOpenId: "ou_jia" }));
  assert.equal(rt.schedules.list().length, 0);
  assert.ok(done.toast?.content.includes("日志巡检"));
});

await t("定时任务卡片：取消之后退回普通状态", async () => {
  const rt = await makeRuntime();
  const created = await seedSchedule(rt);
  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  const base = { botId: "developer", chatId: "oc_test", scheduleId: created.id };
  await handle(cardAction({ action: "schedule_delete", ...base }));
  const cancelled = await handle(cardAction({ action: "schedule_delete_cancel", ...base }));
  assert.equal(rt.schedules.list().length, 1);
  assert.equal(JSON.stringify(cancelled.card.data).includes("确认删除"), false,
    "取消之后不能一直停在待确认");
});

await t("定时任务卡片：越权一律只回 toast，绝不顺手渲染一张列表", async () => {
  const rt = await makeRuntime();
  const created = await seedSchedule(rt);
  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  const kill = (value, overrides) => cardAction(
    { action: "schedule_delete", botId: "developer", chatId: "oc_test",
      scheduleId: created.id, confirmed: true, armedBy: "ou_owner", ...value },
    overrides ?? {},
  );

  // 卡片被转发到别的群：拒了还回卡片的话，等于把本群的任务名送进那个群
  const foreignChat = await handle(kill({}, { chatId: "oc_other" }));
  assert.equal(foreignChat.toast?.type, "error");
  assert.equal(foreignChat.card, undefined, "校验没过就不能回卡片");
  assert.equal(rt.schedules.list().length, 1);

  const foreignBot = await handle(kill({ botId: "reviewer" }));
  assert.equal(foreignBot.toast?.type, "error");
  assert.equal(foreignBot.card, undefined);

  // 压根不存在的 id：resolveOwnSchedule 里 !schedule 那一半分支
  const ghost = await handle(kill({ scheduleId: "sch_nonexistent_00000000" }));
  assert.equal(ghost.toast?.type, "warning");
  assert.equal(ghost.card, undefined);

  // 存在、归属这台 bot，但属于别的群
  const other = await rt.schedules.create({
    botId: "developer", chatId: "oc_secret", name: "别的群的任务",
    cron: "0 9 * * *", prompt: "x", workspaceDir: process.cwd(),
  });
  const crossScope = await handle(kill({ scheduleId: other.id }));
  assert.equal(crossScope.toast?.type, "warning");
  assert.equal(crossScope.card, undefined, "更不能把别的群的任务名回显出去");
  assert.ok(rt.schedules.get(other.id));
});

await t("/schedule 列表按群隔离：别的群的定时任务不出现", async () => {
  // 这条性质此前零覆盖——把 command-handler 换回 listForBot 全套测试照样绿
  const rt = await makeRuntime();
  await seedSchedule(rt, { name: "本群的巡检" });
  await rt.schedules.create({
    botId: "developer", chatId: "oc_secret", name: "别的群的巡检",
    cron: "0 9 * * *", prompt: "x", workspaceDir: process.cwd(),
  });
  const { session, msg } = await seedSession(rt);
  const { bot } = await runCommand(rt, session, msg, "/schedule");
  const json = JSON.stringify(outbound(bot).lastCard());
  assert.ok(json.includes("本群的巡检"));
  assert.equal(json.includes("别的群的巡检"), false,
    "一台 bot 服务多个群，A 群不该看到 B 群的任务名和用途");
});

await t("预算用尽就不再自动续跑，但人随时能重新开始", async () => {
  // 时长上限兜不住「一直在正常产出但方向错了」——那种情况每分钟都在烧钱
  // 而且看起来很健康。真实数据里有一轮跑了 216 分钟才被时长切掉。
  const rt = await makeRuntime();
  const br = rt.botRuntimes.get("developer");
  br.config = { ...br.config, maxTokensPerTask: 1000, reviewBy: "reviewer" };
  const adapter = createFakeAdapter([
    { type: "session", sessionId: "b1" },
    { type: "result", answer: "做完了", sessionId: "b1", stats: { totalTokens: 5000 } },
  ]);
  rt.getAdapter = () => adapter;
  const handle = createMessageHandler({ runtime: rt, config: br.config });
  await handle(userMessage("改点东西", { threadId: "omt_budget" }), br.bot);
  await waitFor(() => rt.taskRecords.size === 1, { label: "第一轮落盘" });
  await new Promise((r) => setTimeout(r, 200));

  // 这一轮自己花了 5000，超过 1000 的上限 → 不该再自动派给 reviewer
  assert.equal(rt.collaborationInbox.size, 0,
    "预算用尽就不该再自动续跑——那正是会失控的地方");
  const replies = outbound(br.bot).all().filter((m) => m.kind === "text");
  assert.ok(replies.some((m) => m.text.includes("上限")),
    "要告诉人为什么停了，以及花了多少");

  // 人再说一句就是新的一件事，从零开始计——预算拦的是自动化，不是人
  await handle(userMessage("接着做", { threadId: "omt_budget2" }), br.bot);
  await waitFor(() => rt.taskRecords.size === 2, { label: "新的一件事照常跑" });
});

await t("多轮的事，详情里每一轮都点得到", async () => {
  // 列表改成按「事」列之后，详情按钮只指向最后一轮，早期轮次在界面上就够不着了。
  // 真实数据里当场有 19 条记录变成不可达——归组和时间线是一件事的两半。
  const rt = await makeRuntime();
  const T = "task-timeline";
  const a = await seedRecord(rt, { taskId: T, prompt: "第一轮：等人拍板", status: "waiting", startedAt: "2026-08-24T02:00:00.000Z", finishedAt: "2026-08-24T02:00:30.000Z" });
  const b = await seedRecord(rt, { taskId: T, prompt: "第二轮：批准后续跑", origin: "resume", startedAt: "2026-08-24T02:05:00.000Z", finishedAt: "2026-08-24T02:05:30.000Z" });
  const c = await seedRecord(rt, { taskId: T, prompt: "第三轮：复查", origin: "handoff", startedAt: "2026-08-24T02:09:00.000Z", finishedAt: "2026-08-24T02:09:30.000Z" });

  const { session, msg } = await seedSession(rt);
  const { bot } = await runCommand(rt, session, msg, "/history");
  const detailBtn = outbound(bot).callbacks(outbound(bot).lastCard())
    .find((v) => v.action === "history_detail");
  assert.equal(detailBtn.recordId, c.id, "列表上的详情按钮指向最后一轮");

  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  const res = await handle(cardAction(detailBtn));
  const json = JSON.stringify(res.card.data);
  assert.ok(json.includes("这件事共 3 轮"), "详情里要说清这件事跑了几轮");
  assert.ok(json.includes("正在看"), "当前这一轮要标出来，不给按钮——点它只会刷同一张卡");

  // 早期两轮必须都有入口，否则它们在界面上就消失了
  const jumps = cardValues(res.card.data)
    .filter((v) => v.action === "history_detail")
    .map((v) => v.recordId);
  assert.ok(jumps.includes(a.id), "第一轮要点得到");
  assert.ok(jumps.includes(b.id), "第二轮要点得到");
  assert.equal(jumps.includes(c.id), false, "正在看的那一轮不该再给按钮");

  // 真的跳得过去
  const first = await handle(cardAction({ ...detailBtn, recordId: a.id }));
  assert.ok(JSON.stringify(first.card.data).includes("第一轮：等人拍板"));
});

await t("一轮的事不画时间线：那是噪音", async () => {
  const rt = await makeRuntime();
  const only = await seedRecord(rt, { prompt: "一次就做完了" });
  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  const res = await handle(cardAction({
    action: "history_detail", botId: "developer", chatId: "oc_test",
    recordId: only.id, page: 1, filter: "all",
  }));
  assert.equal(JSON.stringify(res.card.data).includes("这件事共"), false);
});

await t("/cost：只算本群本机器人的开销，把互审那部分单独列出来", async () => {
  const rt = await makeRuntime();
  await seedRecord(rt, { taskId: "c1", prompt: "本群的活", origin: "user", totalTokens: 100 });
  await seedRecord(rt, { taskId: "c1", prompt: "请复查", origin: "handoff", totalTokens: 700 });
  // 别的群、别的机器人都不该算进来——账单和历史用同一套作用域
  await seedRecord(rt, { taskId: "c2", chatId: "oc_other", prompt: "别的群", totalTokens: 5000 });
  await seedRecord(rt, { taskId: "c3", botId: "reviewer", prompt: "别的 bot", totalTokens: 5000 });

  const { session, msg } = await seedSession(rt);
  const { bot } = await runCommand(rt, session, msg, "/cost");
  const json = JSON.stringify(outbound(bot).lastCard());
  assert.ok(json.includes("800"), "只该算本群本机器人的 800");
  // 断精确的件数轮数，不断「有没有出现 5000」——不过滤的话三笔会被加总成
  // 一个新数字，字面上「5000」照样不出现，那条断言就是空的。
  assert.ok(json.includes("1 件事 · 2 轮执行"),
    "本群本机器人只有 1 件事 2 轮；混进别的群会变成 3 件 4 轮");
  assert.ok(json.includes("团队交接"), "互审那部分要单独看得见");
  assert.ok(json.includes("不是全部开销"), "要说清这只是保留在历史里的那部分");
  assert.equal(rt.activeRuns.size, 0, "/cost 是只读视图，不该顺带跑一次 CLI");
});

await t("同话题里两件事拿到两个任务编号，交接回来的那轮沿用原来的", async () => {
  // 改之前 taskId = hash(chatId:threadId)，于是同一个话题里
  // 「改 README」和「删目录」共用一个编号，四台 bot 各自的执行也共用一个编号——
  // 而这个编号还印在卡片上写着「任务编号」给用户看。话题不是任务。
  const { rt, handle, br } = await wire();
  await handle(userMessage("第一件事", { threadId: "omt_two" }), br.bot);
  await waitFor(() => rt.taskRecords.size === 1, { label: "第一件事落盘" });
  await handle(userMessage("第二件事", { threadId: "omt_two" }), br.bot);
  await waitFor(() => rt.taskRecords.size === 2, { label: "第二件事落盘" });

  const [one, two] = rt.taskRecords.list();
  assert.equal(one.threadId, two.threadId, "前提：两件事确实在同一个话题里");
  assert.notEqual(one.taskId, two.taskId,
    "同一个话题里发生的两件事，不该共用一个任务编号");

  // 交接回来的那一轮属于派活的那件事，必须沿用它的编号，
  // 否则一条完整的协作链在历史里会碎成互不相干的几条。
  const dispatchId = "9999ffff8888";
  rt.collaborationInbox.register({
    chatId: "oc_test", threadId: "omt_two",
    dispatchId, taskId: one.taskId, fromBotId: "reviewer", toBotId: "developer",
    round: 2, maxRounds: 16, workspaceDir: process.cwd(), prompt: "按意见返工",
  });
  await handle(botHandoffMessage(dispatchId, br.identity.openId, { threadId: "omt_two" }), br.bot);
  await waitFor(() => rt.taskRecords.size === 3, { label: "交接轮落盘" });
  const third = rt.taskRecords.list()[2];
  assert.equal(third.taskId, one.taskId, "交接回来的这一轮属于当初那件事");
  assert.equal(third.origin, "handoff");
});

await t("配了 reviewBy：一轮做完自动把改动交给那台 bot 复查", async () => {
  const rt = await makeRuntime();
  const adapter = createFakeAdapter(DONE);
  rt.getAdapter = () => adapter;
  const br = rt.botRuntimes.get("developer");
  // botRuntime 每次 makeRuntime 都是新的，在它身上重新绑一份配置即可，
  // 直接改 br.config.reviewBy 会写进共享的 BOTS 数组，污染后面每条用例
  br.config = { ...br.config, reviewBy: "reviewer" };
  const handle = createMessageHandler({ runtime: rt, config: br.config });
  await handle(userMessage("改一下 README", { threadId: "omt_rv" }), br.bot);
  await waitFor(() => rt.taskRecords.size === 1, { label: "记录落盘" });
  await new Promise((r) => setTimeout(r, 200));

  // 钉的是「交接单真的投出去了」，不是记录状态——
  // reviewBy 这条路记的是 success（dispatch_task 那条记 forwarded），
  // 两者语义上是同一类事件却是两个状态，那是另一个问题，不该由这条用例来断。
  assert.equal(rt.collaborationInbox.size, 1, "该给 reviewer 投一张交接单");
  const [record] = rt.taskRecords.list();
  assert.ok(["success", "forwarded"].includes(record.status),
    "这一轮本身是做完了的");
});

await t("没配 reviewBy：做完就是做完，不该凭空发起一次互审", async () => {
  // 这是本次把自动互审关掉之后的默认行为。没有用例钉着的话，
  // 哪天谁手滑给配置加回一行 reviewBy，多出来的那轮引擎调用没人会发现。
  const { rt, handle, br } = await wire();
  await handle(userMessage("改一下 README", { threadId: "omt_norv" }), br.bot);
  await waitFor(() => rt.taskRecords.size === 1, { label: "记录落盘" });
  await new Promise((r) => setTimeout(r, 200));

  const [record] = rt.taskRecords.list();
  assert.equal(record.status, "success", "没有下家，这一轮就是普通完成");
  assert.equal(rt.collaborationInbox.size ?? 0, 0, "不该往收件箱里放交接单");
});

await t("改了文件却没派验证子 Agent，详情卡要如实标出来", async () => {
  // 这是「结构化验证」的落点：系统自己看得见有没有验过，不靠引擎自报。
  // 措辞上说的是「没有证据表明验过」而不是「做错了」——
  // 活可能干得很好，只是没人复核；说成失败和说成成功一样是撒谎。
  const rt = await makeRuntime();
  const edited = await seedRecord(rt, { prompt: "改了点东西", editedFiles: true });
  const verified = await seedRecord(rt, {
    prompt: "改完还验了", editedFiles: true, subagents: ["tester", "code-reviewer"],
  });
  const readonly_ = await seedRecord(rt, { prompt: "只是读了读" });

  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  const detail = async (id) => {
    const res = await handle(cardAction({
      action: "history_detail", botId: "developer", chatId: "oc_test",
      recordId: id, page: 1, filter: "all",
    }));
    return JSON.stringify(res.card.data);
  };

  assert.ok((await detail(edited.id)).includes("没有 tester / code-reviewer 的痕迹"),
    "改了文件又没验，得让人看见");
  assert.equal((await detail(verified.id)).includes("没有 tester"), false,
    "验过的不该再警告");
  assert.ok((await detail(verified.id)).includes("tester / code-reviewer"),
    "验过谁要写出来，光说「验过了」等于没说");
  assert.equal((await detail(readonly_.id)).includes("没有 tester"), false,
    "只读的一轮没什么可验的，标了只是噪音");
});

await t("卡片删除：接线走通，正在跑的那一轮真的被停掉", async () => {
  // A 组原有的三条只测了 abortScheduleRuns 这个纯函数本身。
  // 从「点删除」到「那一轮停掉」中间还有三个接头：卡片回调拿到 scheduleId、
  // activeRuns 里那条记录带着同一个 id、abort 真的被调用。
  // 一处接错，纯函数测得再全也没用。
  const rt = await makeRuntime();
  const s = await seedSchedule(rt);
  const controller = new AbortController();
  rt.activeRuns.set("developer:oc_test:omt_sched", {
    controller, ownerOpenId: "ou_owner", scheduleId: s.id,
  });
  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  const base = { botId: "developer", chatId: "oc_test", scheduleId: s.id };

  const armed = await handle(cardAction({ action: "schedule_delete", ...base },
    { operatorOpenId: "ou_jia" }));
  assert.equal(controller.signal.aborted, false, "第一步只是要确认，不该停任何东西");

  const confirm = cardValues(armed.card.data).find((v) => v.confirmed === true);
  await handle(cardAction(confirm, { operatorOpenId: "ou_jia" }));
  assert.equal(rt.schedules.list().length, 0);
  assert.equal(controller.signal.aborted, true,
    "存储记录删了，正在跑的那一轮也必须停——否则回执说「已删除」，引擎还在改文件");
});

await t("自然语言删除：走 schedule_manage 也要停掉那一轮，两个入口一个结果", async () => {
  // 卡片那条路补上了中止，工具这条路原来没有——同一件事换个入口结果不一样，
  // 用户不会知道自己走的是哪条路。
  const rt = await makeRuntime();
  const s = await seedSchedule(rt);
  const controller = new AbortController();
  rt.activeRuns.set("developer:oc_test:omt_sched", {
    controller, ownerOpenId: "ou_owner", scheduleId: s.id,
  });
  const adapter = createFakeAdapter([
    { type: "session", sessionId: "d1" },
    {
      type: "tool_call", toolUseId: "tc1", toolName: "schedule_manage",
      input: { action: "delete", id: s.id },
    },
    { type: "result", answer: "已删除", sessionId: "d1" },
  ]);
  rt.getAdapter = () => adapter;
  const br = rt.botRuntimes.get("developer");
  const handle = createMessageHandler({ runtime: rt, config: br.config });
  await handle(userMessage(`把定时任务 ${s.id} 删了`, { threadId: "omt_toolkill" }), br.bot);
  // 等的是「那一轮被停掉」本身，不是「记录消失」——
  // 中止发生在 remove 之后的下一行，等记录消失会在两者之间抢跑，用例自己就会闪。
  await waitFor(() => controller.signal.aborted, {
    label: "工具这条路同样要停掉在飞的那一轮，不能只有卡片按钮管用",
  });
  assert.equal(rt.schedules.get(s.id), undefined, "记录也要真的删掉");
});

await t("定时标记挂在会话上：续跑的轮次照样认得出自己属于哪条定时任务", async () => {
  // 挂在「一轮」上的话，审批拍板后的续跑、澄清答完的续跑、交接回来那轮全都会丢掉它，
  // 删除时就中止不到——而那些轮次恰恰是跑得最久、最需要被停掉的。
  const rt = await makeRuntime();
  const s = await seedSchedule(rt);
  const { session } = await seedSession(rt);
  await rt.sessions.setScheduleId(session.id, s.id);

  assert.equal(rt.sessions.get(session.id).scheduleId, s.id, "标记要落在会话上");

  const { resumeSession } = await R("app/task-runner.js");
  const adapter = createFakeAdapter([
    { type: "session", sessionId: "r1" },
    { type: "result", answer: "跑完了", sessionId: "r1", __delayMs: 800 },
  ]);
  rt.getAdapter = () => adapter;
  const br = rt.botRuntimes.get("developer");
  void resumeSession({
    runtime: rt, botRuntime: br, sessionId: session.id, taskId: "t-resume",
    replyToMessageId: "om_x", replyInThread: true, ownerOpenId: "ou_owner",
    text: "接着干",
  });
  await waitFor(() => rt.activeRuns.size === 1, { label: "续跑起来" });
  const [run] = [...rt.activeRuns.values()];
  assert.equal(run.scheduleId, s.id,
    "续跑那一轮必须仍然带着定时任务标记，否则删除时找不到它");
  run.controller.abort();
  await waitFor(() => rt.activeRuns.size === 0, { label: "收尾" });
});

await t("命令敲错一个字母，给提示而不是派一次 CLI 任务", async () => {
  // 真机上踩的：/schdule（少个 e）被当成任务派了出去，跑满 52 秒、记进历史，
  // 还自动流转给队友做了一轮互审——一个 typo 换来三次引擎调用。
  const { rt, handle, br, adapter, out } = await wire();
  await handle(userMessage("/schdule", { threadId: "omt_typo" }), br.bot);
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(adapter.prompts.length, 0, "打错的命令不该变成一次 CLI 调用");
  assert.equal(rt.taskRecords.size, 0, "更不该记进历史");
  const text = out.lastText();
  assert.ok(text.includes("/schdule"), "要点名是哪个命令不存在");
  assert.ok(text.includes("/schedule"), "要给出最接近的那个，光说「没有」帮不上忙");
});

await t("以 / 开头的路径不算命令，照常当任务派出去", async () => {
  // 拦截不能拦过头：/Users/... 是正经的任务文本，不是打错的命令
  const { rt, handle, br, adapter } = await wire();
  await handle(userMessage("/Users/example/project 这个目录看一下", { threadId: "omt_path" }), br.bot);
  await waitFor(() => adapter.prompts.length > 0, { label: "路径该照常开跑" });
});

await t("群里一条不带 @ 的任务，只有一台 bot 动手", async () => {
  // 真机上验出来的：飞书会把不带 @ 的群消息投递给群里每一台机器人（三台都收到了 /status）。
  // 若不加判断，同一句话会让每台 bot 各起一个 CLI，在同一个工作目录里并发改代码。
  const rt = await makeRuntime();
  const adapters = new Map();
  const handlers = [];
  for (const config of BOTS) {
    const adapter = createFakeAdapter(DONE);
    adapters.set(config.id, adapter);
    handlers.push({ id: config.id, bot: rt.botRuntimes.get(config.id).bot, config });
  }
  // 每台 bot 都有自己的 handler，真机上就是这样：一条消息投递给每一台
  for (const h of handlers) {
    rt.getAdapter = () => adapters.get(h.id);
    const handle = createMessageHandler({ runtime: rt, config: h.config });
    await handle(userMessage("看一下 package.json", { threadId: "omt_noat" }), h.bot);
  }
  await new Promise((r) => setTimeout(r, 300));

  const started = [...adapters.entries()].filter(([, a]) => a.prompts.length > 0).map(([id]) => id);
  assert.deepEqual(started, ["developer"],
    `没点名时只该 Team Leader 接单，实际动手的是 [${started.join(", ")}]`);
});

await t("点名了别人，Team Leader 也不该抢单", async () => {
  const rt = await makeRuntime();
  const adapter = createFakeAdapter(DONE);
  rt.getAdapter = () => adapter;
  const leader = rt.botRuntimes.get("developer");
  const handle = createMessageHandler({ runtime: rt, config: leader.config });
  // @的是 reviewer，developer 虽然是 Team Leader 也要闭嘴
  await handle(userMessage("@_user_1 看一下 package.json", {
    threadId: "omt_other",
    mentions: [{ key: "@_user_1", openId: "ou_reviewer", name: "reviewer" }],
  }), leader.bot);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(adapter.prompts.length, 0, "点名给了别人，Team Leader 不能抢");
  assert.equal(outbound(leader.bot).all().length, 0, "也不该发任何消息");
});

await t("点名认的是显示名：别的应用视角下的 open_id 对不上，也不能抢单", async () => {
  // 真机上栽的：open_id 按应用隔离。用户 @了市场/运营/助理三台，
  // developer 的应用看到的那三个 open_id 跟那三台自己上报的完全对不上，
  // 于是 developer 判定「谁都没点名」，按 Team Leader 规则接了单——
  // 四台 bot 一起开跑、各弹一张澄清卡。
  const rt = await makeRuntime();
  const adapter = createFakeAdapter(DONE);
  rt.getAdapter = () => adapter;
  const leader = rt.botRuntimes.get("developer");
  const handle = createMessageHandler({ runtime: rt, config: leader.config });
  await handle(userMessage("@_user_1 看一下 package.json", {
    threadId: "omt_crossapp",
    // 名字是 reviewer 的显示名，open_id 却是「developer 应用视角下的 reviewer」，
    // 和 reviewer 自己上报的 ou_reviewer 对不上——真机就是这个形状。
    mentions: [{ key: "@_user_1", openId: "ou_reviewer_as_seen_by_developer", name: "reviewer" }],
  }), leader.bot);
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(adapter.prompts.length, 0,
    "点名给了 reviewer，Team Leader 不能因为 open_id 对不上就当成没人点名");
  assert.equal(outbound(leader.bot).all().length, 0, "也不该发任何消息");
});

await t("单聊没有「点名」一说，非 Team Leader 照样接单", async () => {
  const rt = await makeRuntime();
  const adapter = createFakeAdapter(DONE);
  rt.getAdapter = () => adapter;
  const br = rt.botRuntimes.get("reviewer");
  const handle = createMessageHandler({ runtime: rt, config: br.config });
  const msg = userMessage("看一下 package.json", { threadId: "omt_p2p" });
  msg.chatType = "p2p";
  await handle(msg, br.bot);
  await waitFor(() => adapter.prompts.length > 0, { label: "单聊里该照常开跑" });
});

await t("/history 只回一张卡片，不会顺带启动一次 CLI", async () => {
  const { rt, handle, br, adapter, out } = await wire();
  await seedRecord(rt, { prompt: "昨天那个改动" });
  const msg = userMessage("/history", { threadId: "omt_hist" });
  await handle(msg, br.bot);

  assert.equal(adapter.prompts.length, 0, "/history 不能顺带跑一次 CLI");
  assert.equal(rt.activeRuns.size, 0);
  const json = JSON.stringify(out.lastCard());
  assert.ok(json.includes("历史任务") && json.includes("昨天那个改动"));
  const again = await rt.sessions.resolve(msg, "claude", "developer", process.cwd());
  assert.equal(again.isNew, false);
  assert.equal(again.session.status, "idle", "命令分支不该把会话留在执行中或创建中");
});

await t("任务文本带上角色与团队上下文交给引擎", async () => {
  const { handle, br, adapter, rt } = await wire();
  await handle(userMessage("加个搜索框", { threadId: "omt_r2" }), br.bot);
  await waitFor(() => idle(rt));
  const prompt = adapter.prompts[0].prompt;
  assert.ok(prompt.includes("你的角色：开发工程师"));
  assert.ok(prompt.includes("你所在的 Agent 团队"));
  assert.ok(prompt.includes("当前任务：加个搜索框"));
});

await t("协作交接：认领成功后收件箱清空、去重键记下", async () => {
  const { rt, handle, br } = await wire();
  const dispatchId = "aaaaaaaaaaaa";
  const message = {
    chatId: "oc_test", threadId: "omt_h1",
    dispatchId, taskId: "task-1", fromBotId: "reviewer", toBotId: "developer",
    round: 2, maxRounds: 16, workspaceDir: process.cwd(), prompt: "请按审查意见返工",
  };
  rt.collaborationInbox.register(message);
  const msg = botHandoffMessage(dispatchId, br.identity.openId, { threadId: "omt_h1" });
  await handle(msg, br.bot);
  await waitFor(() => idle(rt), { label: "交接任务收尾" });
  assert.equal(rt.collaborationInbox.consume(dispatchId, "developer", { chatId: "oc_test", threadId: "omt_h1" }), undefined,
    "认领后原交接单必须消失");
  assert.equal(rt.processedCollaborationTurns.size, 1, "去重键必须留下");
});

await t("协作交接：没能开跑时交接单退回收件箱、去重键释放", async () => {
  const { rt, handle, br } = await wire();
  const dispatchId = "bbbbbbbbbbbb";
  const message = {
    chatId: "oc_test", threadId: "omt_h2",
    dispatchId, taskId: "task-2", fromBotId: "reviewer", toBotId: "developer",
    round: 2, maxRounds: 16, workspaceDir: process.cwd(), prompt: "请返工",
  };
  rt.collaborationInbox.register(message);
  // 先让这条话题的会话处于执行中，准入会把交接挡回来
  const seed = botHandoffMessage(dispatchId, br.identity.openId, { threadId: "omt_h2" });
  const { session } = await rt.sessions.resolve(seed, "claude", "developer", process.cwd());
  await rt.sessions.transition(session.id, "active");
  rt.activeRuns.set(session.id, { controller: new AbortController(), ownerOpenId: "ou_owner" });

  await handle(seed, br.bot);
  assert.equal(rt.collaborationInbox.size, 1, "没开跑就必须把交接单退回去");
  assert.ok(rt.collaborationInbox.consume(dispatchId, "developer", { chatId: "oc_test", threadId: "omt_h2" }), "退回的交接单应能再次领取");
  assert.equal(rt.processedCollaborationTurns.size, 0, "去重键必须释放，否则重投会被丢弃");
});

await t("协作交接：卡片发不出去时同样退回，不会静默吞掉任务", async () => {
  const { rt, handle, br } = await wire();
  const dispatchId = "cccccccccccc";
  rt.collaborationInbox.register({
    chatId: "oc_test", threadId: "omt_h3",
    dispatchId, taskId: "task-3", fromBotId: "reviewer", toBotId: "developer",
    round: 2, maxRounds: 16, workspaceDir: process.cwd(), prompt: "请返工",
  });
  br.bot.failNext = "replyCard";   // 模拟飞书频控
  await handle(botHandoffMessage(dispatchId, br.identity.openId, { threadId: "omt_h3" }), br.bot);
  await waitFor(() => idle(rt), { label: "失败收尾" });
  assert.equal(rt.collaborationInbox.size, 1, "卡片失败也必须退回交接单");
  assert.equal(rt.processedCollaborationTurns.size, 0);
});

await t("非目标 bot 的消息被忽略，不动收件箱", async () => {
  const { rt, handle, br } = await wire();
  rt.collaborationInbox.register({
    chatId: "oc_test", threadId: "omt_h4",
    dispatchId: "dddddddddddd", taskId: "t", fromBotId: "reviewer", toBotId: "developer",
    round: 1, maxRounds: 16, workspaceDir: process.cwd(), prompt: "p",
  });
  // @的是别人，不是本 bot
  await handle(botHandoffMessage("dddddddddddd", "ou_someone_else", { threadId: "omt_h4" }), br.bot);
  assert.equal(rt.collaborationInbox.size, 1);
  assert.equal(rt.activeRuns.size, 0);
});

await t("bot 消息没有有效取件码时直接忽略", async () => {
  const { rt, handle, br } = await wire();
  const msg = botHandoffMessage("eeeeeeeeeeee", br.identity.openId, { threadId: "omt_h5" });
  // 收件箱里没有这条，认领失败
  await handle(msg, br.bot);
  assert.equal(rt.activeRuns.size, 0);
  assert.equal(rt.processedCollaborationTurns.size, 0);
});

await t("同一取件码重复投递只执行一次", async () => {
  const { rt, handle, br, adapter } = await wire();
  const dispatchId = "ffffffffffff";
  rt.collaborationInbox.register({
    chatId: "oc_test", threadId: "omt_h6",
    dispatchId, taskId: "t", fromBotId: "reviewer", toBotId: "developer",
    round: 1, maxRounds: 16, workspaceDir: process.cwd(), prompt: "p",
  });
  const msg = botHandoffMessage(dispatchId, br.identity.openId, { threadId: "omt_h6" });
  await handle(msg, br.bot);
  await waitFor(() => idle(rt));
  const runsAfterFirst = adapter.prompts.length;
  assert.equal(runsAfterFirst, 1);
  await handle(msg, br.bot);   // 同一条通知再投一次
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(adapter.prompts.length, runsAfterFirst, "同一取件码被执行了两次");
});

await t("会话已关闭时提示新开话题，不启动任务", async () => {
  const { rt, handle, br, out } = await wire();
  const msg = userMessage("继续", { threadId: "omt_r3" });
  const { session } = await rt.sessions.resolve(msg, "claude", "developer", process.cwd());
  await rt.sessions.transition(session.id, "closed");
  await handle(msg, br.bot);
  assert.ok(out.lastText().includes("已经关闭"));
  assert.equal(rt.activeRuns.size, 0);
});

await t("澄清卡片挂着时的普通消息：旧卡失效，已确认答案带进 prompt", async () => {
  const { rt, handle, br, adapter, out } = await wire();
  const msg = userMessage("改成从菜单进入吧", { threadId: "omt_r4" });
  const { session } = await rt.sessions.resolve(msg, "claude", "developer", process.cwd());
  await rt.sessions.transition(session.id, "idle");
  const { topicScopeId, newTaskId } = await R("core/topic-task.js");
  const request = ClarificationRequestSchema.parse({
    title: "确认范围",
    questions: [
      { id: "a", prompt: "从哪进入？", options: [{ id: "x", label: "列表" }, { id: "y", label: "菜单" }] },
      { id: "b", prompt: "展示什么？", options: [{ id: "p", label: "基础" }, { id: "q", label: "全量" }] },
    ],
  });
  const flow = rt.clarificationFlows.create({
    // 卡片按话题挂：用户在话题里补的那句话属于新的一件事，
    // 但要接上的是之前这张卡，所以查找靠 topicId 而不是 taskId。
    taskId: newTaskId(), topicId: topicScopeId(msg), botId: "developer", sessionId: session.id,
    ownerOpenId: "ou_owner", originalMessageId: msg.messageId,
    cardMessageId: "om_clarify_card", replyInThread: true, request,
  });
  rt.clarificationFlows.answer(flow.token, "a", "列表");

  await handle(msg, br.bot);
  await waitFor(() => idle(rt));
  // 旧卡片被改成「已更新」
  const superseded = br.bot.sent.find((x) => x.kind === "update" && x.messageId === "om_clarify_card");
  assert.ok(superseded, "旧澄清卡片没有被标记失效");
  assert.ok(JSON.stringify(superseded.card).includes("已更新"));
  // 已确认的答案随新消息一起回到引擎
  const prompt = adapter.prompts[0].prompt;
  assert.ok(prompt.includes("列表"), "已确认答案没有带回去");
  assert.ok(prompt.includes("改成从菜单进入吧"));
  assert.equal(rt.clarificationFlows.get(flow.token), undefined, "旧流程应已清理");
});

await t("消息里的图片会被下载", async () => {
  const { rt, handle, br } = await wire();
  const msg = userMessage("看这张图", { threadId: "omt_r5" });
  msg.messageType = "post";
  msg.rawContent = JSON.stringify({
    content: [[{ tag: "text", text: "看这张图" }, { tag: "img", image_key: "img_v3_zz" }]],
  });
  await handle(msg, br.bot);
  await waitFor(() => idle(rt));
  const dl = br.bot.sent.find((x) => x.kind === "download");
  assert.ok(dl, "图片没有被下载");
  assert.equal(dl.fileKey, "img_v3_zz");
});

// ─────────────────────────── 任务历史记录 ───────────────────────────
console.log("任务历史");

await t("跑完一轮后，历史里留下一条可复查的记录", async () => {
  const { rt, handle, br } = await wire();
  await handle(userMessage("看一下项目状态", { threadId: "omt_hist1" }), br.bot);
  await waitFor(() => rt.taskRecords.size === 1, { label: "任务记录落盘" });
  const [record] = rt.taskRecords.list();
  assert.equal(record.status, "success");
  assert.equal(record.origin, "user");
  assert.equal(record.botId, "developer");
  assert.equal(record.chatId, "oc_test");
  assert.equal(record.ownerOpenId, "ou_owner");
  assert.ok(record.prompt.includes("看一下项目状态"), "记的应该是任务原文");
  assert.equal(record.answer, "做完了");
  assert.ok(record.cardMessageId, "详情要能指回当时那张任务卡");
  assert.ok(record.durationMs >= 0 && record.startedAt && record.finishedAt);
});

await t("失败的一轮记成 failed，并带上失败原因", async () => {
  const { rt, handle, br } = await wire([{ type: "session", sessionId: "f1" }]);
  await handle(userMessage("干活", { threadId: "omt_hist2" }), br.bot);
  await waitFor(() => rt.taskRecords.size === 1, { label: "失败记录落盘" });
  const [record] = rt.taskRecords.list();
  assert.equal(record.status, "failed");
  assert.ok(record.failureReason, "失败原因不能是空的，否则详情里查不到原因");
});

await t("团队交接产生的执行，来源记成 handoff", async () => {
  const { rt, handle, br } = await wire();
  const dispatchId = "1111aaaa2222";
  rt.collaborationInbox.register({
    chatId: "oc_test", threadId: "omt_hist3",
    dispatchId, taskId: "task-hist", fromBotId: "reviewer", toBotId: "developer",
    round: 2, maxRounds: 16, workspaceDir: process.cwd(), prompt: "请按审查意见返工",
  });
  await handle(botHandoffMessage(dispatchId, br.identity.openId, { threadId: "omt_hist3" }), br.bot);
  await waitFor(() => rt.taskRecords.size === 1, { label: "交接记录落盘" });
  const [record] = rt.taskRecords.list();
  assert.equal(record.origin, "handoff");
  assert.equal(record.ownerName, "reviewer", "交接的发起人是派活的那台 bot");
  assert.ok(record.prompt.includes("请按审查意见返工"));
});

await t("交接轮弹出的澄清卡，人答得了；派活的那台 bot 反而不该算数", async () => {
  // 真机上栽的：助理把活交回来后弹澄清卡，用户点开是「只有任务发起人可以回答」。
  // 因为交接轮的「发起人」是那台派活的 bot，而卡片归属拿的就是这个值——
  // 这张卡于是谁都答不了，任务永远停在那儿。审批门、产品方案卡、以及「停止」同理。
  const { rt, handle, br, out } = await wire([
    { type: "session", sessionId: "h1" },
    {
      type: "tool_call", toolUseId: "tc1", toolName: "request_clarification",
      input: {
        title: "确认范围",
        questions: [{
          id: "a", prompt: "改哪一版？",
          options: [{ id: "x", label: "线上" }, { id: "y", label: "灰度" }],
        }],
      },
    },
    { type: "result", answer: "先确认一下", sessionId: "h1" },
  ]);
  const dispatchId = "3333cccc4444";
  rt.collaborationInbox.register({
    chatId: "oc_test", threadId: "omt_ask",
    dispatchId, taskId: "task-ask", fromBotId: "reviewer", toBotId: "developer",
    round: 1, maxRounds: 16, workspaceDir: process.cwd(), prompt: "帮我改一下",
  });
  await handle(botHandoffMessage(dispatchId, br.identity.openId, { threadId: "omt_ask" }), br.bot);
  await waitFor(() => rt.taskRecords.size === 1, { label: "等人记录落盘" });

  const [record] = rt.taskRecords.list();
  assert.equal(record.status, "waiting");
  assert.equal(record.ownerName, "reviewer",
    "历史里的发起人仍然是派活那台 bot——那条信息有用，不该为了修卡片把它也改掉");

  const answer = out.callbacks(out.lastUpdate())
    .find((v) => v.action === "answer_clarification");
  assert.ok(answer, "澄清卡上要有可点的选项");

  const handleCard = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  // 断行为而不是 toast 类型：文案和类型都可能改，答案有没有落盘不会变
  const byBot = await handleCard(cardAction(answer, { operatorOpenId: "ou_sender_bot" }));
  assert.notEqual(byBot.toast?.type, "success", "派活的那台 bot 不能替人拍板");
  assert.equal(rt.clarificationFlows.get(answer.flowToken).answers.length, 0,
    "被拒绝就不能留下答案");

  const byHuman = await handleCard(cardAction(answer, { operatorOpenId: "ou_owner" }));
  assert.equal(byHuman.toast?.type, "success",
    "人必须答得了——答不了的话这张卡和这一轮任务就永远卡在那儿");
  assert.equal(rt.clarificationFlows.get(answer.flowToken).answers.length, 1,
    "人的答案要真的落进流程里");
});

await t("交接轮跑起来之后，人停得掉；派活的那台 bot 停不掉", async () => {
  // 「停止」和澄清卡是同一个归属值。交接轮里它是那台派活的 bot 的话，
  // 一个跑飞了的任务，人点「停止」会被判 forbidden——比答不了澄清卡更糟。
  const { rt, handle, br } = await wire([
    { type: "session", sessionId: "s1" },
    { type: "result", answer: "跑完了", sessionId: "s1", __delayMs: 3_000 },
  ]);
  const dispatchId = "5555eeee6666";
  rt.collaborationInbox.register({
    chatId: "oc_test", threadId: "omt_stop",
    dispatchId, taskId: "task-stop", fromBotId: "reviewer", toBotId: "developer",
    round: 1, maxRounds: 16, workspaceDir: process.cwd(), prompt: "跑个长任务",
  });
  void handle(botHandoffMessage(dispatchId, br.identity.openId, { threadId: "omt_stop" }), br.bot);
  await waitFor(() => rt.activeRuns.size === 1, { label: "任务跑起来" });

  const [sessionId] = [...rt.activeRuns.keys()];
  const handleCard = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  const byBot = await handleCard(cardAction({ action: "abort_task", sessionId },
    { operatorOpenId: "ou_sender_bot" }));
  assert.notEqual(byBot.toast?.type, "success", "派活的那台 bot 不该有停止权");

  const byHuman = await handleCard(cardAction({ action: "abort_task", sessionId },
    { operatorOpenId: "ou_owner" }));
  assert.equal(byHuman.toast?.type, "success", "人必须停得掉跑飞的交接任务");
  await waitFor(() => rt.activeRuns.size === 0, { label: "任务收尾" });
});

await t("人发起的任务把发起人名字查出来落进历史；查不到就留空退化显示", async () => {
  const { rt, handle, br } = await wire();
  br.bot.names.set("ou_lin", "小林");
  await handle(userMessage("看一下依赖", { threadId: "omt_owner1", senderOpenId: "ou_lin" }), br.bot);
  await waitFor(() => rt.taskRecords.size === 1, { label: "记录落盘" });
  assert.equal(rt.taskRecords.list()[0].ownerName, "小林",
    "飞书的消息事件只带 open_id，名字要查通讯录——不查的话历史里全是一串 id");

  // 应用没有通讯录权限时接口会「成功但不返回 name」，这条路径必须照常跑完
  const two = await wire();
  await two.handle(userMessage("再看一下", { threadId: "omt_owner2", senderOpenId: "ou_nobody" }), two.br.bot);
  await waitFor(() => two.rt.taskRecords.size === 1, { label: "记录落盘" });
  const record = two.rt.taskRecords.list()[0];
  assert.equal(record.ownerName, undefined, "查不到就别塞一个空字符串进去");
  assert.equal(record.ownerOpenId, "ou_nobody", "退化显示靠的是 open_id，它必须还在");
});

/** 这一档在卡片上叫「成功」，用它验「某个结局到底算不算做完了」。 */
const successBucket = (rt) =>
  queryTaskRecords(rt.taskRecords.list(), {
    chatId: "oc_test", botId: "developer", filter: "success",
  }).tasks.map((r) => r.prompt);

await t("弹出澄清卡的那一轮记成「等人拍板」，不进成功档", async () => {
  const { rt, handle, br, out } = await wire([
    { type: "session", sessionId: "w1" },
    {
      type: "tool_call", toolUseId: "tc1", toolName: "request_clarification",
      input: {
        title: "确认范围",
        questions: [{
          id: "a", prompt: "从哪进入？",
          options: [{ id: "x", label: "列表" }, { id: "y", label: "菜单" }],
        }],
      },
    },
    { type: "result", answer: "先确认一下再动手", sessionId: "w1" },
  ]);
  await handle(userMessage("加个搜索框", { threadId: "omt_hist_wait" }), br.bot);
  await waitFor(() => rt.taskRecords.size === 1, { label: "等人记录落盘" });

  // 先确认走的确实是澄清分支，不然下面的断言可能是在验一条别的路径
  assert.ok(JSON.stringify(out.lastUpdate()).includes("从哪进入？"), "澄清卡没有发出来");
  const [record] = rt.taskRecords.list();
  assert.equal(record.status, "waiting", "任务停在澄清卡上等人回答，历史里不能记成做完了");
  assert.deepEqual(successBucket(rt), [], "还等着人回答的任务不该出现在「成功」档里");
});

await t("派给队友的那一轮记成「已交接」，仍然算做完了", async () => {
  const { rt, handle, br } = await wire([
    { type: "session", sessionId: "d1" },
    {
      type: "tool_call", toolUseId: "tc1", toolName: "dispatch_task",
      input: { toBotId: "reviewer", task: "帮我审一下这次改动" },
    },
    { type: "result", answer: "已经交给审查了", sessionId: "d1" },
  ]);
  await handle(userMessage("改完了，找人审一下", { threadId: "omt_hist_fwd" }), br.bot);
  await waitFor(() => rt.taskRecords.size === 1, { label: "交接记录落盘" });

  const [record] = rt.taskRecords.list();
  assert.equal(record.status, "forwarded", "活派出去了，这一轮确实做完了");
  // 不要误伤：拆分状态是为了拦住「等人拍板」，不是把交接一起赶出成功档
  assert.deepEqual(successBucket(rt), ["改完了，找人审一下"]);
});

await t("弹出审批卡的那一轮记成「等人拍板」，不进成功档", async () => {
  const { rt, handle, br, out } = await wire([
    { type: "session", sessionId: "a1" },
    {
      type: "tool_call", toolUseId: "tc1", toolName: "request_approval",
      input: {
        title: "清空缓存目录", summary: "删掉 data/cache 下的全部文件",
        impact: "缓存会重建，期间接口变慢", risk: "high",
      },
    },
    { type: "result", answer: "等你拍板", sessionId: "a1" },
  ]);
  await handle(userMessage("把缓存清一下", { threadId: "omt_hist_appr" }), br.bot);
  await waitFor(() => rt.taskRecords.size === 1, { label: "审批记录落盘" });

  // 先确认真的走了审批分支，否则下面断的可能是另一条路径
  assert.ok(JSON.stringify(out.lastUpdate()).includes("清空缓存目录"), "审批卡没有发出来");
  const [record] = rt.taskRecords.list();
  assert.equal(record.status, "waiting", "任务停在审批卡上等人拍板，不能记成做完了");
  assert.deepEqual(successBucket(rt), [], "还等着人拍板的任务不该出现在「成功」档里");
});

await t("弹出产品方案卡的那一轮记成「等人拍板」，不进成功档", async () => {
  const rt = await makeRuntime();
  const adapter = createFakeAdapter([
    { type: "session", sessionId: "p1" },
    {
      type: "tool_call", toolUseId: "tc1", toolName: "request_spec_approval",
      // 走 lark-doc：local 模式会额外校验方案文件真实存在，那是另一条链路的事，
      // 这条用例要盯的是「弹出确认卡的这一轮算不算做完了」。
      input: {
        title: "搜索功能方案", summary: "先做关键词搜索",
        deliveryMode: "lark-doc", documentUrl: "https://x.feishu.cn/docx/SPEC1",
      },
    },
    { type: "result", answer: "方案等你确认", sessionId: "p1" },
  ]);
  rt.getAdapter = () => adapter;
  const br = rt.botRuntimes.get("developer");
  // 产品方案分支要求这台 bot 带产品类 Skill。botRuntime 对象每次 makeRuntime 都是新的，
  // 所以在它身上重新绑一份配置即可——直接改 br.config.skills 会写进共享的 BOTS 数组，
  // 后面每一条用例都会跟着带上这个 Skill。
  br.config = { ...br.config, skills: ["to-spec"] };
  const handle = createMessageHandler({ runtime: rt, config: br.config });
  await handle(userMessage("搜索功能怎么做", { threadId: "omt_hist_spec" }), br.bot);
  await waitFor(() => rt.taskRecords.size === 1, { label: "产品方案记录落盘" });

  const [record] = rt.taskRecords.list();
  assert.equal(record.status, "waiting", "方案还等着人确认，不能记成做完了");
  assert.deepEqual(successBucket(rt), []);
});

await t("定时任务改成功的那一轮记成「已交接」，仍然算做完了", async () => {
  const { rt, handle, br } = await wire([
    { type: "session", sessionId: "s1" },
    {
      type: "tool_call", toolUseId: "tc1", toolName: "schedule_manage",
      input: {
        action: "create", name: "每天早报", cron: "0 9 * * *",
        prompt: "汇总昨天的进展", workspaceDir: process.cwd(),
      },
    },
    { type: "result", answer: "已经建好了", sessionId: "s1" },
  ]);
  await handle(userMessage("每天九点给我发早报", { threadId: "omt_hist_sched" }), br.bot);
  await waitFor(() => rt.taskRecords.size === 1, { label: "定时任务记录落盘" });

  const [record] = rt.taskRecords.list();
  // 定时任务已经生效，这一轮确实做完了——拆分状态是为了拦「等人拍板」，不是连它一起赶走
  assert.equal(record.status, "forwarded", "定时任务已生效，这一轮做完了");
  assert.deepEqual(successBucket(rt), ["每天九点给我发早报"]);
});

await t("/compact 是上下文维护，不写任务记录", async () => {
  const { rt, handle, br } = await wire();
  await handle(userMessage("先跑一轮", { threadId: "omt_hist4" }), br.bot);
  await waitFor(() => rt.taskRecords.size === 1, { label: "首轮记录落盘" });
  await handle(userMessage("/compact", { threadId: "omt_hist4" }), br.bot);
  await waitFor(() => idle(rt), { label: "整理收尾" });
  assert.equal(rt.taskRecords.size, 1, "/compact 不该在历史里多出一条");
});

await t("写记录失败不改变任务结局，会话照样回到空闲", async () => {
  // 断言必须落在「隔离被拆掉时真的会坏」的东西上。
  // 绿卡在 try 里就 finish 了、activeRuns 也在 releaseSession 里先清掉了，
  // 拿它们做断言的话，把 recordTaskRun 的 try/catch 删掉测试照样全绿。
  const { rt, handle, br, out } = await wire();
  rt.taskRecords.append = async () => { throw new Error("磁盘满"); };
  await handle(userMessage("照常干活", { threadId: "omt_hist5" }), br.bot);
  await waitFor(() => idle(rt), { label: "任务收尾" });
  assert.equal(out.lastUpdate().header.template, "green", "写历史失败把成功改写成了失败");
  assert.equal(rt.activeRuns.size, 0);
  // 真正会坏的一：message-router 会把成功的任务当成启动失败，补发一张红卡
  const startupFailure = out
    .of("card")
    .filter((c) => JSON.stringify(c.card).includes("任务没有启动"));
  assert.equal(startupFailure.length, 0, "写历史失败让用户收到了「任务没有启动」红卡");
});

await t("写记录失败时 runCliTurn 仍然返回 success（调度器据此记录结果）", async () => {
  // 真正会坏的二：调度器 await runCliTurn，异常会让本轮结局从 success 变成 failed。
  const { runCliTurn, taskAdmission } = await R("app/task-runner.js");
  const { rt, br } = await wire();
  rt.taskRecords.append = async () => { throw new Error("磁盘满"); };
  const msg = userMessage("照常干活", { threadId: "omt_hist6" });
  const { session } = await rt.sessions.resolve(msg, "claude", "developer", process.cwd());
  await rt.sessions.transition(session.id, "idle");
  assert.equal(taskAdmission(rt, session).ok, true);
  const outcome = await runCliTurn({
    runtime: rt, botRuntime: br, session, taskId: "t-hist6",
    replyToMessageId: msg.messageId, replyInThread: true,
    ownerOpenId: "ou_owner", prompt: "干活", taskText: "干活",
    cardTitle: "假引擎", origin: "thread",
  });
  assert.equal(outcome, "success", "写历史失败把本轮结局从 success 改成了别的");
});

await t("引擎失败时渲染红卡并 @人，会话仍回到空闲", async () => {
  const { rt, handle, br, out } = await wire(
    [{ type: "session", sessionId: "f1" }],   // 没有 result 事件 → 协议没走完
    { adapterOptions: { exitCode: 0 } },
  );
  await handle(userMessage("干活", { threadId: "omt_r6" }), br.bot);
  await waitFor(() => idle(rt), { label: "失败收尾" });
  const final = out.lastUpdate();
  assert.equal(final.header.template, "red");
  assert.ok(out.of("mention").some((m) => m.text.includes("执行失败")));
  assert.equal(rt.activeRuns.size, 0, "失败也必须释放会话");
});


const AT_BOT = [{ key: "@_user_1", name: "agent-os", openId: "ou_bot" }];

await t("只 @机器人 不写任务时给提示，不启动 CLI、不建会话", async () => {
  const { rt, handle, br, adapter, out } = await wire();
  const before = rt.sessions.size;
  await handle(
    userMessage("@_user_1", { threadId: "omt_empty", mentions: AT_BOT }),
    br.bot,
  );
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(adapter.prompts.length, 0, "空任务不该起 CLI 进程");
  assert.ok(out.lastText().includes("没有任务内容"));
  assert.equal(rt.activeRuns.size, 0);
  assert.equal(rt.sessions.size, before, "空任务不该留下一个卡在 creating 的会话");
});

await t("空任务提示之后，同一话题的下一条任务照常执行", async () => {
  const { rt, handle, br, adapter } = await wire();
  await handle(
    userMessage("@_user_1", { threadId: "omt_empty_then", mentions: AT_BOT }),
    br.bot,
  );
  await new Promise((r) => setTimeout(r, 200));
  // 上一条如果把会话留在 creating，这一条只会收到「会话正在准备」。
  await handle(
    userMessage("@_user_1 读一下 package.json", {
      threadId: "omt_empty_then",
      mentions: AT_BOT,
    }),
    br.bot,
  );
  await waitFor(() => idle(rt), { label: "空任务之后的正常任务" });
  assert.equal(adapter.prompts.length, 1, "同话题的后续任务必须能跑起来");
  assert.ok(adapter.prompts[0].prompt.includes("读一下 package.json"));
});

await t("@名字 和正文之间没有空格时不算空任务", async () => {
  const { rt, handle, br, adapter } = await wire();
  // 飞书里从下拉框选中 @ 再直接打字，正文就是这个形状。
  await handle(
    userMessage("@_user_1读一下 package.json", {
      threadId: "omt_no_space",
      mentions: AT_BOT,
    }),
    br.bot,
  );
  await waitFor(() => idle(rt), { label: "无空格 @ 任务" });
  assert.equal(adapter.prompts.length, 1, "紧贴 @ 的正文被误判成了空任务");
  assert.ok(adapter.prompts[0].prompt.includes("读一下 package.json"));
});

await t("@名字后面不打空格也算有任务（真机踩到的）", async () => {
  // 中文里 @agent-os读一下 很常见；用 /@\S+/ 剥离会把整段吃掉，把真任务判成空。
  const { rt, handle, br, adapter } = await wire();
  const msg = userMessage("@_user_1读一下package.json", {
    threadId: "omt_nospace",
    mentions: [{ key: "@_user_1", name: "agent-os", openId: "ou_bot" }],
  });
  await handle(msg, br.bot);
  await waitFor(() => idle(rt), { label: "无空格任务" });
  assert.equal(adapter.prompts.length, 1, "无空格的真任务被当成空任务挡掉了");
  assert.ok(adapter.prompts[0].prompt.includes("读一下package.json"));
});

await t("post 消息里 at 渲染成 open_id，同样能判空", async () => {
  const { rt, handle, br, adapter, out } = await wire();
  const msg = userMessage("ou_bot", {
    threadId: "omt_postempty",
    mentions: [{ key: "@_user_1", name: "agent-os", openId: "ou_bot" }],
  });
  msg.messageType = "post";
  await handle(msg, br.bot);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(adapter.prompts.length, 0);
  assert.ok(out.lastText().includes("没有任务内容"));
});

await t("有任务内容时正常放行", async () => {
  const { rt, handle, br, adapter } = await wire();
  await handle(
    userMessage("@_user_1 读一下 package.json", {
      threadId: "omt_nonempty",
      mentions: AT_BOT,
    }),
    br.bot,
  );
  await waitFor(() => idle(rt));
  assert.equal(adapter.prompts.length, 1);
  assert.ok(adapter.prompts[0].prompt.includes("读一下 package.json"));
});

await t("[授权] 未授权用户、群与空名单在创建会话和下载附件之前被拒绝", async () => {
  const cases = [
    { config: { allowedUserOpenIds: ["ou_owner"] }, senderOpenId: "ou_stranger", chatId: "oc_test" },
    { config: { allowedUserOpenIds: ["ou_owner"], allowedChatIds: ["oc_allowed"] }, senderOpenId: "ou_owner", chatId: "oc_test" },
    { config: { allowedUserOpenIds: [], ownerOpenId: "ou_owner" }, senderOpenId: "ou_owner", chatId: "oc_test" },
    { config: { allowedUserOpenIds: undefined, ownerOpenId: undefined }, senderOpenId: "ou_owner", chatId: "oc_test" },
  ];
  for (const c of cases) {
    const { rt, br, adapter } = await wire();
    const config = { ...br.config, ...c.config };
    const handle = createMessageHandler({ runtime: rt, config });
    await handle({ ...userMessage("/schedule 建一个任务", c), messageType: "file", rawContent: JSON.stringify({ file_key: "sensitive-file" }) }, br.bot);
    assert.equal(rt.sessions.size, 0);
    assert.equal(adapter.prompts.length, 0);
    assert.equal(outbound(br.bot).of("download").length, 0);
    assert.equal(outbound(br.bot).all().length, 0);
  }
});

await t("[授权] 未授权的卡片点击只返回提示，不泄漏历史详情", async () => {
  const rt = await makeRuntime();
  const record = await seedRecord(rt, { answer: "private history body" });
  const config = { ...BOTS[0], allowedUserOpenIds: ["ou_owner"], allowedChatIds: ["oc_test"] };
  const handle = createCardActionHandler({ runtime: rt, config });
  for (const actor of [{ operatorOpenId: "ou_stranger" }, { chatId: "oc_other" }]) {
    const res = await handle(cardAction({ action: "history_detail", botId: "developer", chatId: "oc_test", recordId: record.id }, actor));
    assert.match(res.toast.content, /未获授权/);
    assert.equal(res.card, undefined);
    assert.equal(JSON.stringify(res).includes("private history body"), false);
  }
});

await t("[授权] 恢复旧目录的执行也受白名单约束，拒绝后会话回到空闲", async () => {
  const { rt, br, adapter } = await wire();
  br.config = { ...br.config, allowedWorkspaceDirs: [process.cwd()] };
  const msg = userMessage("继续旧任务", { threadId: "omt_outside_workspace" });
  const { session } = await rt.sessions.resolve(msg, "claude", "developer", dir);
  await rt.sessions.transition(session.id, "idle");
  const handle = createMessageHandler({ runtime: rt, config: br.config });
  await handle(msg, br.bot);
  assert.equal(adapter.prompts.length, 0);
  assert.equal(rt.activeRuns.size, 0);
  assert.equal(rt.sessions.get(session.id).status, "idle");
});

await t("[授权] 定时触发也拒绝越界目录与已撤销的群，且不发出话题", async () => {
  const { Scheduler } = await R("app/scheduler.js");
  for (const patch of [{ allowedWorkspaceDirs: [process.cwd()] }, { allowedChatIds: [] }]) {
    const { rt, br, adapter } = await wire();
    br.config = { ...br.config, ...patch };
    const schedule = await seedSchedule(rt, { workspaceDir: dir });
    await new Scheduler(rt).run(schedule);
    assert.equal(adapter.prompts.length, 0);
    assert.equal(outbound(br.bot).of("thread").length, 0);
    assert.equal(rt.schedules.get(schedule.id).lastStatus, "failed");
  }
});

await t("[定时] 首轮执行就带着任务标记，删除该计划能立即中止它", async () => {
  const { Scheduler } = await R("app/scheduler.js");
  const { abortScheduleRuns } = await R("core/task-abort.js");
  const { rt, br } = await wire([{ type: "session", sessionId: "schedule-first" }, { type: "result", answer: "done", __delayMs: 1000 }]);
  const schedule = await seedSchedule(rt);
  const running = new Scheduler(rt).run(schedule);
  await waitFor(() => rt.activeRuns.size === 1, { label: "定时首轮占位" });
  const active = [...rt.activeRuns.values()][0];
  assert.equal(active.scheduleId, schedule.id);
  await rt.schedules.remove(schedule.id);
  assert.equal(abortScheduleRuns(rt.activeRuns, schedule.id), "stopped");
  await running;
  assert.equal(active.controller.signal.aborted, true);
  assert.equal(rt.activeRuns.size, 0);
  assert.equal(outbound(br.bot).of("thread").length, 1);
});

await t("[授权] 新话题目录失效后不留 creating，目录恢复后同话题可以重试", async () => {
  const { rt, br, adapter } = await wire();
  const restored = join(dir, "restored-workspace");
  br.config = { ...br.config, workspaceDir: restored, allowedWorkspaceDirs: [dir] };
  const msg = userMessage("先运行一次", { threadId: "omt_workspace_retry" });
  const handle = createMessageHandler({ runtime: rt, config: br.config });
  await handle(msg, br.bot);
  const { session } = await rt.sessions.resolve(msg, "claude", "developer", restored);
  assert.equal(adapter.prompts.length, 0);
  assert.equal(rt.sessions.get(session.id).status, "idle");
  assert.equal(rt.activeRuns.size, 0);
  mkdirSync(restored);
  await handle(userMessage("目录已恢复，再试一次", { threadId: msg.threadId }), br.bot);
  await waitFor(() => rt.taskRecords.size === 1 && idle(rt), { label: "恢复后重试成功" });
  assert.equal(adapter.prompts.length, 1);
  assert.equal(rt.taskRecords.list()[0].status, "success");
});

await t("[授权] 云文档评论仅方案主人可续跑，撤销群授权后也不可执行", async () => {
  const { runProductDocumentComment } = await R("app/product-comment-runner.js");
  const { rt, br, adapter } = await wire();
  const { session } = await seedSession(rt);
  await rt.sessions.setCliSessionId(session.id, "comment-session");
  const flow = rt.productSpecFlows.create({ taskId: "comment-task", topicId: "comment-topic", botId: "developer", sessionId: session.id,
    ownerOpenId: "ou_owner", request: { title: "方案", summary: "说明", deliveryMode: "lark-doc", documentUrl: "https://example.feishu.cn/docx/Example" } });
  const comment = { eventId: "comment-event", fileToken: "Example", fileType: "docx", commentId: "comment", replyId: "", senderOpenId: "ou_other", senderUnionId: "on_other", mentionedBot: true };
  await assert.rejects(() => runProductDocumentComment({ runtime: rt, bot: br.bot, flow, comment }), /只有已获授权/);
  assert.equal(adapter.prompts.length, 0);
  await runProductDocumentComment({ runtime: rt, bot: br.bot, flow, comment: { ...comment, senderOpenId: "ou_owner", senderUnionId: "on_owner" } });
  assert.equal(adapter.prompts.length, 1);
  assert.equal(outbound(br.bot).of("comment").length, 1);
  const allowedUsers = br.config.allowedUserOpenIds;
  br.config = { ...br.config, allowedUserOpenIds: [] };
  await assert.rejects(() => runProductDocumentComment({ runtime: rt, bot: br.bot, flow, comment: { ...comment, senderOpenId: "ou_owner" } }), /只有已获授权/);
  assert.equal(adapter.prompts.length, 1);
  br.config = { ...br.config, allowedUserOpenIds: allowedUsers, allowedChatIds: [] };
  await assert.rejects(() => runProductDocumentComment({ runtime: rt, bot: br.bot, flow, comment: { ...comment, senderOpenId: "ou_owner" } }), /只有已获授权/);
  assert.equal(adapter.prompts.length, 1);
  assert.equal(rt.sessions.get(session.id).status, "idle");
  assert.equal(rt.activeRuns.size, 0);
});

await t("[并发] 评论目录检查期间同会话重入，已有占位不被覆盖且只启动一次引擎", async () => {
  const { runProductDocumentComment } = await R("app/product-comment-runner.js");
  const { rt, br, adapter } = await wire();
  const { session } = await seedSession(rt);
  await rt.sessions.setCliSessionId(session.id, "comment-concurrent");
  const flow = rt.productSpecFlows.create({ taskId: "comment-race", topicId: "comment-race", botId: "developer", sessionId: session.id,
    ownerOpenId: "ou_owner", request: { title: "方案", summary: "说明", deliveryMode: "lark-doc", documentUrl: "https://example.feishu.cn/docx/Race" } });
  const comment = { eventId: "race", fileToken: "Race", fileType: "docx", commentId: "race", replyId: "", senderOpenId: "ou_owner", senderUnionId: "on_owner", mentionedBot: true };
  const first = runProductDocumentComment({ runtime: rt, bot: br.bot, flow, comment });
  const occupied = rt.activeRuns.get(session.id);
  assert.ok(occupied, "第一个异步目录检查之前必须同步占位");
  await assert.rejects(() => runProductDocumentComment({ runtime: rt, bot: br.bot, flow, comment }), /仍在执行/);
  assert.equal(rt.activeRuns.get(session.id), occupied);
  await first;
  assert.equal(adapter.prompts.length, 1);
  assert.equal(rt.activeRuns.size, 0);
  assert.equal(rt.sessions.get(session.id).status, "idle");
});

await t("[隐私] 默认消息日志不输出正文", async () => {
  const { rt, br, handle } = await wire();
  const lines = [];
  const previous = console.log;
  console.log = (...values) => lines.push(values.join(" "));
  try {
    await handle(userMessage("private-message-canary", { threadId: "omt_privacy" }), br.bot);
    await waitFor(() => idle(rt), { label: "隐私测试执行收尾" });
  } finally {
    console.log = previous;
  }
  assert.ok(lines.some((line) => line.includes("[收到]")), "必须确实捕获到消息日志");
  assert.equal(lines.join("\n").includes("private-message-canary"), false);
});

await t("[授权] 已授权用户转发流程卡片到别的群，也不能操作原群会话", async () => {
  const rt = await makeRuntime();
  let adapterLookups = 0;
  rt.getAdapter = () => { adapterLookups += 1; return createFakeAdapter(DONE); };
  const { session } = await seedSession(rt);
  const product = rt.productSpecFlows.create({ taskId: "scope-product", topicId: "scope-topic", botId: "developer", sessionId: session.id,
    ownerOpenId: "ou_owner", request: { title: "private spec", summary: "private summary", deliveryMode: "lark-doc", documentUrl: "https://example.feishu.cn/docx/Scope" } });
  const approval = rt.approvalFlows.create({ taskId: "scope-approval", botId: "developer", sessionId: session.id, ownerOpenId: "ou_owner",
    originalMessageId: "om_scope", replyInThread: true, request: { title: "private approval", summary: "summary", impact: "impact", risk: "high" } });
  const clarification = rt.clarificationFlows.create({ taskId: "scope-clarify", topicId: "scope-topic", botId: "developer", sessionId: session.id,
    ownerOpenId: "ou_owner", originalMessageId: "om_scope", replyInThread: true,
    request: ClarificationRequestSchema.parse({ title: "private question", questions: [{ id: "q", prompt: "选哪个？", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] }) });
  const controller = new AbortController();
  const handle = createCardActionHandler({ runtime: rt, config: BOTS[0] });
  for (const value of [
    { action: "approve_product_spec", flowToken: product.token },
    { action: "decide_approval", flowToken: approval.token, decision: "approved" },
    { action: "answer_clarification", flowToken: clarification.token, questionId: "q", optionId: "a" },
    { action: "resume_cli_session", agentSessionId: session.id, cliSessionId: "other-context" },
    { action: "abort_task", sessionId: session.id },
  ]) {
    if (value.action === "abort_task") rt.activeRuns.set(session.id, { controller, ownerOpenId: "ou_owner" });
    const res = await handle(cardAction(value, { chatId: "oc_forwarded" }));
    assert.ok(res.toast, value.action);
    assert.equal(res.card, undefined, value.action);
    assert.equal(JSON.stringify(res).includes("private"), false, value.action);
  }
  assert.equal(product.status, "pending");
  assert.equal(approval.status, "pending");
  assert.equal(clarification.currentIndex, 0);
  assert.deepEqual(clarification.answers, []);
  assert.equal(controller.signal.aborted, false);
  assert.equal(rt.sessions.get(session.id).cliSessionId, undefined);
  assert.equal(adapterLookups, 0, "转发的恢复按钮不能读取原群的引擎历史");
});

await t("[交接范围] 跨群、跨话题与撤销授权不能烧掉票据，原话题仍可恰好领取一次", async () => {
  const { rt, br, adapter } = await wire([
    { type: "session", sessionId: "dispatch-scope" },
    { type: "tool_call", toolUseId: "dispatch", toolName: "dispatch_task", input: { toBotId: "reviewer", task: "检查实现" } },
    { type: "result", sessionId: "dispatch-scope", answer: "已派发" },
  ]);
  br.config = { ...br.config, collaborationMaxRounds: 1 };
  const sourceHandle = createMessageHandler({ runtime: rt, config: br.config });
  const sourceMessage = userMessage("请审查", { threadId: "omt_delivery_scope" });
  await sourceHandle(sourceMessage, br.bot);
  await waitFor(() => rt.taskRecords.size === 1 && idle(rt), { label: "交接票据已生成" });
  assert.equal(rt.taskRecords.list()[0].status, "forwarded");
  assert.equal(adapter.prompts.length, 1);
  const notice = outbound(br.bot).of("mention").find((item) => item.text.includes("任务编号："));
  const dispatchId = notice.text.match(/任务编号：([a-f0-9]{12})/)[1];
  const target = rt.botRuntimes.get("reviewer");
  target.config = { ...target.config };
  const targetAdapter = createFakeAdapter(DONE);
  rt.getAdapter = () => targetAdapter;
  const targetHandle = createMessageHandler({ runtime: rt, config: target.config });
  const delivery = (over = {}) => botHandoffMessage(dispatchId, target.identity.openId, { threadId: sourceMessage.threadId, ...over });
  for (const wrongScope of [{ chatId: "oc_other" }, { threadId: "omt_other", rootId: "om_other" }]) {
    await targetHandle(delivery(wrongScope), target.bot);
    assert.equal(rt.collaborationInbox.size, 1);
    assert.equal(rt.processedCollaborationTurns.size, 0);
    assert.equal(targetAdapter.prompts.length, 0);
    assert.equal(outbound(target.bot).all().length, 0);
    assert.equal(rt.sessions.size, 1);
  }
  const allowedUsers = target.config.allowedUserOpenIds;
  const owner = target.config.ownerOpenId;
  target.config.allowedUserOpenIds = [];
  await targetHandle(delivery(), target.bot);
  assert.equal(rt.collaborationInbox.size, 1);
  assert.equal(targetAdapter.prompts.length, 0);
  target.config.allowedUserOpenIds = allowedUsers;
  target.config.ownerOpenId = undefined;
  await targetHandle(delivery(), target.bot);
  assert.equal(rt.collaborationInbox.size, 1);
  assert.equal(targetAdapter.prompts.length, 0);
  target.config.ownerOpenId = owner;
  await targetHandle(delivery(), target.bot);
  await waitFor(() => rt.taskRecords.size === 2 && idle(rt), { label: "原话题合法交接完成" });
  assert.equal(rt.collaborationInbox.size, 0);
  assert.equal(rt.processedCollaborationTurns.size, 1);
  assert.equal(targetAdapter.prompts.length, 1);
  const received = rt.taskRecords.list().find((row) => row.botId === "reviewer");
  assert.equal(received.chatId, sourceMessage.chatId);
  assert.equal(received.threadId, sourceMessage.threadId);
  await targetHandle(delivery(), target.bot);
  assert.equal(targetAdapter.prompts.length, 1);
});

await t("[交接范围] 发送侧拒绝无授权目标，通知发送失败会撤销票据", async () => {
  const { sendCollaborationMessage } = await R("app/collaboration-service.js");
  const { rt, br } = await wire();
  const target = rt.botRuntimes.get("reviewer");
  const policy = { ...target.config };
  const request = { runtime: rt, sender: br, replyToMessageId: "om_source", chatId: "oc_test", threadId: "omt_send",
    targetBotId: "reviewer", taskId: "send-task", kind: "forward", round: 1, maxRounds: 1, workspaceDir: process.cwd(), prompt: "检查" };
  for (const denied of [{ allowedUserOpenIds: [] }, { allowedChatIds: [] }, { ownerOpenId: undefined }]) {
    target.config = { ...policy, ...denied };
    await assert.rejects(() => sendCollaborationMessage(request), /未获授权/);
    assert.equal(rt.collaborationInbox.size, 0);
    assert.equal(outbound(br.bot).all().length, 0);
  }
  target.config = policy;
  br.bot.replyMention = async () => undefined;
  await assert.rejects(() => sendCollaborationMessage(request), /协作通知/);
  assert.equal(rt.collaborationInbox.size, 0);
});

await t("[交接范围] 根消息建会话后，真实回复的 rootId 仍可匹配原话题票据", async () => {
  const { rt, br, adapter, handle } = await wire();
  rt.collaborationInbox.register({ dispatchId: "001122aabbcc", taskId: "root-delivery", fromBotId: "reviewer", toBotId: "developer",
    chatId: "oc_test", threadId: "om_root", round: 1, maxRounds: 1, workspaceDir: process.cwd(), prompt: "处理根消息任务" });
  await handle(botHandoffMessage("001122aabbcc", br.identity.openId, { threadId: "omt_server_generated", rootId: "om_root" }), br.bot);
  await waitFor(() => rt.taskRecords.size === 1 && idle(rt), { label: "根消息范围匹配" });
  assert.equal(adapter.prompts.length, 1);
  assert.equal(rt.collaborationInbox.size, 0);
});

await t("[评论终态] 等待期间确认或替换方案，排队评论不得启动引擎", async () => {
  const { runProductDocumentComment } = await R("app/product-comment-runner.js");
  for (const terminal of ["approved", "expired"]) {
    const { rt, br, adapter } = await wire();
    const { session } = await seedSession(rt);
    await rt.sessions.setCliSessionId(session.id, "queued-comment-context");
    const create = (documentUrl) => rt.productSpecFlows.create({ taskId: "terminal-comment", topicId: "terminal-topic", botId: "developer",
      sessionId: session.id, ownerOpenId: "ou_owner", request: { title: "方案", summary: "说明", deliveryMode: "lark-doc", documentUrl } });
    const flow = create("https://example.feishu.cn/docx/Terminal");
    const snapshot = { ...flow };
    const comment = { eventId: "terminal", fileToken: "Terminal", fileType: "docx", commentId: "terminal", replyId: "", senderOpenId: "ou_owner", senderUnionId: "on_owner", mentionedBot: true };
    let release;
    const reactionPending = new Promise((resolve) => { release = resolve; });
    const queued = reactionPending.then(() => runProductDocumentComment({ runtime: rt, bot: br.bot, flow: snapshot, comment }));
    if (terminal === "approved") rt.productSpecFlows.approve(flow.token);
    else create("https://example.feishu.cn/docx/NewProposal");
    release();
    await assert.rejects(queued, /方案已确认或失效/);
    assert.equal(rt.productSpecFlows.get(flow.token).status, terminal);
    assert.equal(adapter.prompts.length, 0);
    assert.equal(outbound(br.bot).of("comment").length, 0);
    assert.equal(rt.activeRuns.size, 0);
    assert.equal(rt.sessions.get(session.id).status, "idle");
  }
});

await t("[评论终态] 检查目录期间方案终态改变，也会释放占位且不执行", async () => {
  const { runProductDocumentComment } = await R("app/product-comment-runner.js");
  const { rt, br, adapter } = await wire();
  const { session } = await seedSession(rt);
  await rt.sessions.setCliSessionId(session.id, "checking-comment-context");
  const flow = rt.productSpecFlows.create({ taskId: "checking-comment", topicId: "checking-topic", botId: "developer", sessionId: session.id,
    ownerOpenId: "ou_owner", request: { title: "方案", summary: "说明", deliveryMode: "lark-doc", documentUrl: "https://example.feishu.cn/docx/Checking" } });
  const comment = { eventId: "checking", fileToken: "Checking", fileType: "docx", commentId: "checking", replyId: "", senderOpenId: "ou_owner", senderUnionId: "on_owner", mentionedBot: true };
  const running = runProductDocumentComment({ runtime: rt, bot: br.bot, flow, comment });
  assert.equal(rt.activeRuns.size, 1);
  rt.productSpecFlows.approve(flow.token);
  await assert.rejects(running, /方案已确认或失效/);
  assert.equal(flow.status, "approved");
  assert.equal(adapter.prompts.length, 0);
  assert.equal(rt.activeRuns.size, 0);
  assert.equal(rt.sessions.get(session.id).status, "idle");
});

await t("[resume接线] workspace 命令与恢复按钮都保留终端会话，默认范围仍拒绝它", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentos-resume-app-"));
  const cwd = process.cwd();
  const project = join(root, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "external-workspace.jsonl"), JSON.stringify({ type: "user", cwd, sessionId: "external-workspace",
    message: { role: "user", content: "终端任务，不带 Agent OS 角色前缀" } }) + "\n");
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  try {
    const rt = await makeRuntime();
    const { session, msg } = await seedSession(rt);
    const br = rt.botRuntimes.get("developer");
    br.config = { ...br.config, resumeScope: "workspace" };
    await runCommand(rt, session, msg, "/resume");
    const card = outbound(br.bot).lastCard();
    const choice = cardValues(card).find((value) => value.action === "resume_cli_session" && value.cliSessionId === "external-workspace");
    assert.ok(choice, "命令必须把 workspace 范围传给原生读取，默认过滤后再放宽已经找不回外部会话");
    const selected = await createCardActionHandler({ runtime: rt, config: br.config })(cardAction(choice));
    assert.equal(selected.toast.type, "success");
    assert.equal(rt.sessions.get(session.id).cliSessionId, "external-workspace", "恢复按钮也必须传入 workspace 范围");
    await rt.sessions.clearCliSessionId(session.id);
    br.config = { ...br.config, resumeScope: "agent-os" };
    await runCommand(rt, rt.sessions.get(session.id), msg, "/resume");
    assert.equal(JSON.stringify(outbound(br.bot).lastCard()).includes("external-workspace"), false);
    const denied = await createCardActionHandler({ runtime: rt, config: br.config })(cardAction(choice));
    assert.equal(denied.toast.type, "error");
    assert.equal(rt.sessions.get(session.id).cliSessionId, undefined);
  } finally {
    // 原生历史根不能泄漏到其他用例或运行账号的真实会话目录。
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

await t("[交接接线] 自动返回的票据保留原群话题和递增轮次，并可被队友实际领取", async () => {
  const { rt, br, handle, adapter } = await wire();
  const scope = { chatId: "oc_test", threadId: "omt_auto_return" };
  rt.collaborationInbox.register({ dispatchId: "aabbccddee11", taskId: "return-scope", fromBotId: "reviewer", toBotId: "developer",
    ...scope, round: 1, maxRounds: 2, workspaceDir: process.cwd(), prompt: "按意见处理" });
  await handle(botHandoffMessage("aabbccddee11", br.identity.openId, scope), br.bot);
  await waitFor(() => rt.taskRecords.size === 1 && idle(rt), { label: "首轮处理并自动发回" });
  const notice = outbound(br.bot).of("mention").find((item) => item.text.includes("任务编号："));
  assert.ok(notice, "自动返回不能因缺失投递范围而静默失败");
  const dispatchId = notice.text.match(/任务编号：([a-f0-9]{12})/)[1];
  const returned = rt.collaborationInbox.consume(dispatchId, "reviewer", scope);
  assert.ok(returned, "自动返回票据必须能在原群原话题领取");
  assert.equal(returned.chatId, scope.chatId);
  assert.equal(returned.threadId, scope.threadId);
  assert.equal(returned.taskId, "return-scope");
  assert.equal(returned.round, 2);
  assert.equal(returned.maxRounds, 2);
  assert.equal(returned.fromBotId, "developer");
  rt.collaborationInbox.register(returned);
  const target = rt.botRuntimes.get("reviewer");
  await createMessageHandler({ runtime: rt, config: target.config })(botHandoffMessage(dispatchId, target.identity.openId, scope), target.bot);
  await waitFor(() => rt.taskRecords.size === 2 && idle(rt), { label: "队友接回自动返回的结果" });
  assert.equal(adapter.prompts.length, 2);
  assert.equal(rt.collaborationInbox.size, 0);
  assert.ok(rt.taskRecords.list().every((row) => row.chatId === scope.chatId && row.threadId === scope.threadId));
});

console.log(`\n${pass} passed`);
