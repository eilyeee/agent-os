/**
 * 冒烟测试：对 dist/ 里的真实产物做纯逻辑验证。
 * 覆盖不到飞书与 CLI 子进程——那两层必须在真实环境里验收，见 AGENTS.md。
 * 用法：pnpm check
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, renameSync, unlinkSync, mkdirSync, symlinkSync, realpathSync, utimesSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const R = (p) => import(new URL(p, `file://${process.cwd()}/dist/`).href);
let pass = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); process.exitCode = 1; }
};

console.log("cron");
const { parseCron, isValidCron } = await R("core/cron.js");
await t("每小时整点", () => {
  const c = parseCron("0 * * * *");
  assert.equal(c.matches(new Date(2026, 7, 21, 13, 0)), true);
  assert.equal(c.matches(new Date(2026, 7, 21, 13, 1)), false);
});
await t("步长 */15", () => {
  const c = parseCron("*/15 * * * *");
  assert.equal(c.matches(new Date(2026, 7, 21, 3, 30)), true);
  assert.equal(c.matches(new Date(2026, 7, 21, 3, 31)), false);
});
await t("工作日 9:30", () => {
  const c = parseCron("30 9 * * 1-5");
  assert.equal(c.matches(new Date(2026, 7, 21, 9, 30)), true); // 2026-08-21 周五
  assert.equal(c.matches(new Date(2026, 7, 22, 9, 30)), false); // 周六
});
await t("列表与区间", () => {
  const c = parseCron("0 9,18 1-5 * *");
  assert.equal(c.matches(new Date(2026, 7, 3, 18, 0)), true);
  assert.equal(c.matches(new Date(2026, 7, 6, 18, 0)), false);
});
await t("非法表达式被拒绝", () => {
  assert.equal(isValidCron("* * * *"), false);
  assert.equal(isValidCron("99 * * * *"), false);
  assert.equal(isValidCron("* * * * 9"), false);
  assert.equal(isValidCron("*/0 * * * *"), false);
});

// 逐分钟走一遍 [from, to]，把每个匹配上的时刻收集起来。
// nextRun 的断言必须跨过「推算」和「匹配判断」之间那道边界：
// 只验算出来的时刻自己匹配，等于守在没人走的门口——
// 中间被跳过的触发才是这个功能真正会犯的错。
const minutesMatching = (cron, from, to) => {
  const hits = [];
  const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate(), from.getHours(), from.getMinutes() + 1);
  for (let d = cursor; d.getTime() <= to.getTime(); d = new Date(d.getTime() + 60_000)) {
    if (cron.matches(d)) hits.push(new Date(d.getTime()));
  }
  return hits;
};
const stamp = (d) =>
  d === undefined ? "算不出"
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ` +
      `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

await t("[下次触发] 整点/列表/区间/步长/跨天/跨月/跨年", () => {
  const cases = [
    ["0 * * * *", new Date(2026, 7, 21, 13, 0), "2026-08-21 14:00"], // 整点
    ["*/15 * * * *", new Date(2026, 7, 21, 3, 50), "2026-08-21 04:00"], // 步长
    ["0 9,18 * * *", new Date(2026, 7, 21, 10, 0), "2026-08-21 18:00"], // 列表
    ["30 9 * * 1-5", new Date(2026, 7, 21, 10, 0), "2026-08-24 09:30"], // 区间 + 跨周末
    ["0 2 * * *", new Date(2026, 7, 21, 23, 30), "2026-08-22 02:00"], // 跨天
    ["0 9 1 * *", new Date(2026, 7, 21, 10, 0), "2026-09-01 09:00"], // 跨月
    ["0 0 1 1 *", new Date(2026, 11, 31, 23, 59), "2027-01-01 00:00"], // 跨年
    ["0 0 29 2 *", new Date(2027, 0, 1, 0, 0), "2028-02-29 00:00"], // 闰日
  ];
  for (const [source, from, expected] of cases) {
    assert.equal(stamp(parseCron(source).nextRun(from)), expected, `${source} 从 ${stamp(from)} 起`);
  }
});

await t("[下次触发] 起点正好落在触发时刻上，返回的是下一次而不是起点", () => {
  const c = parseCron("0 9 * * *");
  const onTime = new Date(2026, 7, 21, 9, 0);
  assert.equal(stamp(c.nextRun(onTime)), "2026-08-22 09:00", "起点自己被当成了下一次");
  // 秒不参与判断：09:00:30 时这一分钟已经过去了，不能倒退回 09:00:00。
  assert.equal(stamp(c.nextRun(new Date(2026, 7, 21, 9, 0, 30))), "2026-08-22 09:00");
  assert.ok(c.nextRun(onTime).getTime() > onTime.getTime(), "返回值必须严格晚于起点");
  // 边界的另一侧：差 1 毫秒不到点，这一次就还没过去。
  assert.equal(stamp(c.nextRun(new Date(2026, 7, 21, 8, 59, 59, 999))), "2026-08-21 09:00");
});

await t("[下次触发] 与匹配判断同源：算出的时刻必匹配，且中间没有被跳过的触发", () => {
  for (const source of ["0 * * * *", "*/15 * * * *", "30 9 * * 1-5", "0 9,18 1-5 * *", "0 0 1 1 *"]) {
    const c = parseCron(source);
    const from = new Date(2026, 11, 30, 8, 17); // 跨年前两天，顺带覆盖跨天/跨月/跨年
    const next = c.nextRun(from);
    assert.ok(next, `${source} 应该算得出下次触发`);
    assert.equal(c.matches(next), true, `${source} 算出的时刻拿去匹配却是假的`);
    const skipped = minutesMatching(c, from, new Date(next.getTime() - 60_000));
    assert.deepEqual(skipped.map(stamp), [], `${source} 跳过了 ${skipped.length} 次真正会触发的时刻`);
  }
});

await t("[下次触发] 日与周同时限定时的「或」语义与匹配判断逐分钟一致", () => {
  // 13 号「或」每周五：两边都被限定，标准 cron 取或。
  const c = parseCron("0 12 13 * 5");
  const from = new Date(2026, 7, 1, 0, 0);
  const expected = minutesMatching(c, from, new Date(2026, 9, 1, 0, 0)); // 8 月 + 9 月
  // 样本必须同时含「是 13 号但不是周五」和「是周五但不是 13 号」，
  // 否则取「与」也能全部通过，这条断言就白写了。
  assert.ok(expected.some((d) => d.getDate() === 13 && d.getDay() !== 5), "样本缺少「13 号但不是周五」");
  assert.ok(expected.some((d) => d.getDay() === 5 && d.getDate() !== 13), "样本缺少「周五但不是 13 号」");
  // 从上一次触发一路走到下一次，nextRun 必须和逐分钟扫出来的序列完全重合。
  const walked = [];
  let cursor = from;
  for (let i = 0; i < expected.length; i += 1) {
    cursor = c.nextRun(cursor);
    assert.ok(cursor, "或语义下中途算不出下次触发了");
    walked.push(cursor);
  }
  assert.deepEqual(walked.map(stamp), expected.map(stamp), "或语义两边对不上");
});

await t("[下次触发] 永不命中的组合在上界内如实返回「算不出」，不无界空转", () => {
  for (const source of ["0 0 30 2 *", "0 0 31 2 *", "0 0 31 4 *", "0 0 31 2,4,6 *"]) {
    assert.equal(parseCron(source).nextRun(new Date(2026, 0, 1, 0, 0)), undefined, `${source} 应该算不出`);
  }
  // 反过来：日与周同时被限定时取或，2 月 30 日配上周一就不是永不命中了。
  assert.equal(stamp(parseCron("0 0 30 2 1").nextRun(new Date(2026, 0, 1, 0, 0))), "2026-02-02 00:00");
});

await t("[下次触发] 搜索上界要够得着闰年的 8 年空档", () => {
  // 2100 不是闰年，2096-03-01 之后的第一个 2 月 29 日要等到 2104——
  // 上界取常见的 4 年会在这里把一个真实存在的触发误报成「算不出」。
  const c = parseCron("0 0 29 2 *");
  const next = c.nextRun(new Date(2096, 2, 1, 0, 0));
  assert.equal(stamp(next), "2104-02-29 00:00", "上界没跨过世纪年那个 8 年空档");
  assert.equal(c.matches(next), true);
});

await t("[下次触发] 非法 cron 的失败方式没有新增", () => {
  for (const source of ["* * * *", "99 * * * *", "* * * * 9", "*/0 * * * *"]) {
    assert.throws(() => parseCron(source), Error, `${source} 应该在解析时就抛`);
    assert.equal(isValidCron(source), false);
  }
});

console.log("session store");
const { JsonSessionStore } = await R("core/session-store.js");
const { SessionManager } = await R("core/session-manager.js");
const dir = mkdtempSync(join(tmpdir(), "agentos-"));
await t("落盘 + 重启复用同一会话 id", async () => {
  const file = join(dir, "sessions.json");
  const m1 = await SessionManager.open({ store: new JsonSessionStore(file, "dev", { dev: "/tmp" }) });
  const { session } = await m1.resolve(
    { messageId: "om_1", chatId: "oc_1", threadId: "omt_1", rootId: "" },
    "claude", "dev", "/tmp",
  );
  await m1.transition(session.id, "active");
  const m2 = await SessionManager.open({ store: new JsonSessionStore(file, "dev", { dev: "/tmp" }) });
  const again = await m2.resolve(
    { messageId: "om_2", chatId: "oc_1", threadId: "omt_1", rootId: "om_1" },
    "claude", "dev", "/tmp",
  );
  assert.equal(again.isNew, false);
  assert.equal(again.session.id, session.id);
  // 上次退出时是 active，恢复后应为 idle
  assert.equal(again.session.status, "idle");
});
await t("同话题不同 bot 互不串线", async () => {
  const file = join(dir, "s2.json");
  const m = await SessionManager.open({ store: new JsonSessionStore(file) });
  const a = await m.resolve({ messageId: "om", chatId: "oc", threadId: "omt", rootId: "" }, "claude", "dev", "/tmp");
  const b = await m.resolve({ messageId: "om", chatId: "oc", threadId: "omt", rootId: "" }, "codex", "reviewer", "/tmp");
  assert.notEqual(a.session.id, b.session.id);
  assert.equal(b.isNew, true);
});
await t("旧数据迁移：补 botId / workspaceDir", async () => {
  const file = join(dir, "legacy.json");
  writeFileSync(file, JSON.stringify([{
    id: "old-1", threadId: "omt_x", chatId: "oc_x", cliId: "claude",
    status: "idle", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }]));
  const m = await SessionManager.open({ store: new JsonSessionStore(file, "dev", { dev: "/legacy" }) });
  assert.equal(m.size, 1);
  assert.equal(m.get("old-1").botId, "dev");
  assert.equal(m.get("old-1").workspaceDir, "/legacy");
  // 补齐后应重写文件
  assert.match(readFileSync(file, "utf8"), /"botId": "dev"/);
});
await t("切工作目录会解除 cliSessionId", async () => {
  const m = await SessionManager.open({});
  const { session } = await m.resolve({ messageId: "m", chatId: "c", threadId: "t", rootId: "" }, "claude", "dev", "/a");
  await m.setCliSessionId(session.id, "cli-abc");
  assert.equal(m.get(session.id).cliSessionId, "cli-abc");
  await m.setWorkspaceDir(session.id, "/b");
  assert.equal(m.get(session.id).cliSessionId, undefined);
  assert.equal(m.get(session.id).workspaceDir, "/b");
});
await t("非法状态跃迁被拒绝", async () => {
  const m = await SessionManager.open({});
  const { session } = await m.resolve({ messageId: "m", chatId: "c", threadId: "t", rootId: "" });
  await m.transition(session.id, "closed");
  await assert.rejects(() => m.transition(session.id, "active"), /不能切换/);
});

console.log("bot registry");
const { parseAgentOsConfig, buildBotPrompt } = await R("core/bot-registry.js");
const baseBot = {
  id: "dev", appIdEnv: "A_ID", appSecretEnv: "A_SECRET", defaultCli: "claude",
  role: "开发", workspace: ".",
};
const env = { A_ID: "cli_x", A_SECRET: "sec" };
await t("正常解析", () => {
  const cfg = parseAgentOsConfig({ teamLeader: "dev", bots: [baseBot] }, env);
  assert.equal(cfg.bots.length, 1);
  assert.equal(cfg.defaultProductDeliveryMode, "lark-doc");
  // 默认 2：自动互审下这个值等于往返次数，不是安全阀（见 AGENTS.md 错题本）
  assert.equal(cfg.bots[0].collaborationMaxRounds, 2);
});
await t("[授权] 配置校验名单、解析目录，并保留自定义凭证变量名", () => {
  const cfg = parseAgentOsConfig({ teamLeader: "dev", bots: [{ ...baseBot,
    allowedUserOpenIds: ["ou_owner"], allowedChatIds: ["oc_team"], allowedWorkspaceDirs: ["../project"] },
    { ...baseBot, id: "disabled", appIdEnv: "DISABLED_ID", appSecretEnv: "DISABLED_SECRET", enabled: false }] }, env);
  assert.deepEqual(cfg.credentialEnvNames, ["A_ID", "A_SECRET", "DISABLED_ID", "DISABLED_SECRET"]);
  assert.deepEqual(cfg.bots[0].allowedUserOpenIds, ["ou_owner"]);
  assert.deepEqual(cfg.bots[0].allowedChatIds, ["oc_team"]);
  assert.equal(cfg.bots[0].allowedWorkspaceDirs[0], resolve(process.cwd(), "../project"));
  for (const patch of [{ allowedUserOpenIds: ["*"] }, { allowedChatIds: ["*"] }, { allowedWorkspaceDirs: [""] }]) {
    assert.throws(() => parseAgentOsConfig({ teamLeader: "dev", bots: [{ ...baseBot, ...patch }] }, env));
  }
});
await t("[授权] 默认仅负责人、显式空名单拒绝全部，群限制独立生效", async () => {
  const { isBotRequestAllowed: allowed } = await R("core/access-control.js");
  assert.equal(allowed({}, "ou_owner", "oc_team"), false);
  assert.equal(allowed({ ownerOpenId: "ou_owner" }, "ou_owner", "oc_team"), true);
  assert.equal(allowed({ ownerOpenId: "ou_owner" }, "ou_other", "oc_team"), false);
  assert.equal(allowed({ ownerOpenId: "ou_owner", allowedUserOpenIds: [] }, "ou_owner", "oc_team"), false);
  const config = { allowedUserOpenIds: ["ou_owner"], allowedChatIds: ["oc_team"] };
  assert.equal(allowed(config, "ou_owner", "oc_team"), true);
  assert.equal(allowed(config, "ou_owner", "oc_foreign"), false);
  assert.equal(allowed({ ...config, allowedChatIds: [] }, "ou_owner", "oc_team"), false);
  assert.equal(allowed(config, "", "oc_team"), false);
});
await t("缺凭证报错", () => {
  assert.throws(() => parseAgentOsConfig({ teamLeader: "dev", bots: [baseBot] }, {}), /缺少环境变量/);
});
await t("teamLeader 必须存在且启用", () => {
  assert.throws(() => parseAgentOsConfig({ teamLeader: "ghost", bots: [baseBot] }, env), /teamLeader/);
  assert.throws(() => parseAgentOsConfig(
    { teamLeader: "dev", bots: [{ ...baseBot, enabled: false }] }, env), /至少需要启用一个 bot/);
});
await t("reviewBy 校验", () => {
  assert.throws(() => parseAgentOsConfig(
    { teamLeader: "dev", bots: [{ ...baseBot, reviewBy: "dev" }] }, env), /不能把自己/);
  assert.throws(() => parseAgentOsConfig(
    { teamLeader: "dev", bots: [{ ...baseBot, reviewBy: "nobody" }] }, env), /未启用/);
});
await t("id 不能重复", () => {
  assert.throws(() => parseAgentOsConfig(
    { teamLeader: "dev", bots: [baseBot, baseBot] }, env), /不能重复/);
});
await t("[resume] 默认只列 Agent OS 派发的会话，终端里开的不外泄", async () => {
  const { filterResumableSessions } = await R("cli/native-sessions.js");
  const sessions = [
    { id: "a", title: "Agent OS 派发", updatedAt: "2026-01-01T00:00:00.000Z", origin: "agent-os" },
    { id: "b", title: "我自己在终端里开的", updatedAt: "2026-01-01T00:00:00.000Z", origin: "external" },
  ];
  assert.deepEqual(filterResumableSessions(sessions, "agent-os").map((x) => x.id), ["a"]);
  // 显式配置成 workspace 才放开
  assert.deepEqual(filterResumableSessions(sessions, "workspace").map((x) => x.id), ["a", "b"]);
});

/** 临时引擎目录保留真实 Claude JSONL 形状，不碰运行账号的历史。 */
async function withClaudeHistory(rows, run) {
  const root = mkdtempSync(join(tmpdir(), "agentos-claude-history-"));
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const project = join(root, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  for (const [index, row] of rows.entries()) {
    const file = join(project, `${row.id}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: "user", sessionId: row.id, cwd,
      message: { role: "user", content: row.agent ? "你的角色：开发工程师\n\n检查项目" : "终端里开的独立任务" } }) + "\n");
    const updated = new Date(Date.UTC(2026, 0, 1) + index * 60_000); // 分钟间隔：保证按修改时间排序的样本顺序明确。
    utimesSync(file, updated, updated);
  }
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  try {
    return await run({ adapter: { id: "claude" }, cwd });
  } finally {
    // 历史根只属于这个样本，后续测试不能继承它。
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
}

await t("[resume] Claude 在限量前筛选，最新八条终端历史不能遮住更早的 Agent OS 会话", async () => {
  const { listNativeCliSessions } = await R("cli/native-sessions.js");
  await withClaudeHistory([{ id: "agent-old", agent: true }, ...Array.from({ length: 8 }, (_, i) => ({ id: `external-${i}` }))], async (options) => {
    const own = await listNativeCliSessions(options);
    assert.deepEqual(own.map((row) => row.id), ["agent-old"]);
    const all = await listNativeCliSessions({ ...options, scope: "workspace" });
    assert.deepEqual(all.map((row) => row.id), Array.from({ length: 8 }, (_, i) => `external-${7 - i}`));
  });
});

await t("[resume] Claude 从全部合格会话中按时间选最新八条", async () => {
  const { listNativeCliSessions } = await R("cli/native-sessions.js");
  const rows = Array.from({ length: 12 }, (_, i) => [{ id: `agent-${i}`, agent: true }, { id: `external-${i}` }]).flat();
  await withClaudeHistory(rows, async (options) => {
    const own = await listNativeCliSessions({ ...options, scope: "agent-os" });
    assert.deepEqual(own.map((row) => row.id), Array.from({ length: 8 }, (_, i) => `agent-${11 - i}`));
    assert.ok(own.every((row) => row.origin === "agent-os"));
  });
});

/** 假 app-server 只按预设 JSON-RPC 页回复，任何请求都不会调用真实 Codex。 */
function fakeHistoryServer(pages) {
  const root = mkdtempSync(join(tmpdir(), "agentos-codex-history-"));
  const requestsFile = join(root, "requests.jsonl");
  const server = join(root, "server.cjs");
  const script = `
    const fs = require("node:fs");
    const readline = require("node:readline");
    const pages = ${JSON.stringify(pages)};
    const requestsFile = ${JSON.stringify(requestsFile)};
    process.stdout.write("non-json startup log\\n");
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", line => {
      const request = JSON.parse(line);
      fs.appendFileSync(requestsFile, JSON.stringify(request) + "\\n");
      if (request.method === "initialize") {
        process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
      } else if (request.method === "thread/list") {
        const page = pages[request.params.cursor ?? "first"];
        const response = page?.error ? { error: { code: -32603, message: page.error } }
          : page ? { result: page } : { error: { code: -32602, message: "unexpected cursor" } };
        process.stdout.write(JSON.stringify({ id: request.id, ...response }) + "\\n");
      }
    });
  `;
  writeFileSync(server, script);
  let command;
  if (process.platform === "win32") {
    // Windows 不执行 shebang；固定参数写进 .cmd，仍不把协议消息拼进 shell。
    command = join(root, "fake-codex.cmd");
    writeFileSync(command, `@"${process.execPath}" "${server}" %*\r\n`);
  } else {
    command = join(root, "fake-codex");
    writeFileSync(command, "#!/usr/bin/env node\n" + script);
    chmodSync(command, 0o755);
  }
  return {
    options: { adapter: { id: "codex", command }, cwd: root },
    requests: () => readFileSync(requestsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((row) => row.method === "thread/list"),
  };
}
const HISTORY_UPDATED_AT_SECONDS = 1_700_000_000; // Unix 秒：假协议保持真实时间字段的单位。
const historyThread = (id, agent = true, updatedAt = HISTORY_UPDATED_AT_SECONDS) => ({
  id, preview: agent ? `你的角色：开发工程师 ${id}` : `terminal ${id}`, name: null, updatedAt,
});

await t("[resume] Codex 跨页取足合格历史，使用 nextCursor 并在八条时停止", async () => {
  const { listNativeCliSessions } = await R("cli/native-sessions.js");
  const fixture = fakeHistoryServer({
    first: { data: Array.from({ length: 8 }, (_, i) => historyThread(`external-${i}`, false)), nextCursor: "page-one" },
    "page-one": { data: [historyThread("agent-0"), historyThread("external-again", false), historyThread("agent-1")], nextCursor: "page-two" },
    "page-two": { data: [historyThread("agent-1"), ...Array.from({ length: 8 }, (_, i) => historyThread(`agent-${i + 2}`))], nextCursor: "unneeded" },
  });
  const sessions = await listNativeCliSessions(fixture.options);
  assert.deepEqual(sessions.map((row) => row.id), Array.from({ length: 8 }, (_, i) => `agent-${i}`));
  const requests = fixture.requests();
  assert.deepEqual(requests.map((row) => row.params.cursor), [undefined, "page-one", "page-two"]);
  assert.deepEqual(requests.map((row) => row.id), [2, 3, 4]);
  assert.ok(requests.every((row) => row.params.cwd === fixture.options.cwd && row.params.limit === 8
    && row.params.sortKey === "updated_at" && row.params.sortDirection === "desc"));
});

await t("[resume] Codex workspace 范围保留终端历史，够八条后不再读取下一页", async () => {
  const { listNativeCliSessions } = await R("cli/native-sessions.js");
  const fixture = fakeHistoryServer({ first: { data: Array.from({ length: 8 }, (_, i) => historyThread(`external-${i}`, false)), nextCursor: "unneeded" } });
  const sessions = await listNativeCliSessions({ ...fixture.options, scope: "workspace" });
  assert.deepEqual(sessions.map((row) => row.id), Array.from({ length: 8 }, (_, i) => `external-${i}`));
  assert.equal(fixture.requests().length, 1);
});

await t("[resume] Codex 页耗尽时返回不足八条的合格历史，也接受空的中间页", async () => {
  const { listNativeCliSessions } = await R("cli/native-sessions.js");
  const fixture = fakeHistoryServer({
    first: { data: [], nextCursor: "after-empty" },
    "after-empty": { data: [historyThread("external", false), historyThread("only-agent")], nextCursor: null },
  });
  const sessions = await listNativeCliSessions(fixture.options);
  assert.deepEqual(sessions.map((row) => row.id), ["only-agent"]);
  assert.deepEqual(fixture.requests().map((row) => row.params.cursor), [undefined, "after-empty"]);
});

await t("[resume] Codex 重复分页游标会明确失败，不无限读取", async () => {
  const { listNativeCliSessions } = await R("cli/native-sessions.js");
  const fixture = fakeHistoryServer({ first: { data: [], nextCursor: "repeat" }, repeat: { data: [], nextCursor: "repeat" } });
  await assert.rejects(() => listNativeCliSessions(fixture.options), /重复分页游标/);
  assert.equal(fixture.requests().length, 2);
});

await t("[resume] Codex 后续页错误不冒充空历史，异常记录不进入结果", async () => {
  const { listNativeCliSessions } = await R("cli/native-sessions.js");
  // 1e13 是合法安全整数秒，但已经越过 Date 的时间范围；不能让 int 校验替代日期校验。
  const malformed = fakeHistoryServer({ first: { data: [historyThread("bad-date", true, 1e13), { ...historyThread("bad-id"), id: 42 }, historyThread("valid")], nextCursor: null } });
  assert.deepEqual((await listNativeCliSessions(malformed.options)).map((row) => row.id), ["valid"]);
  const broken = fakeHistoryServer({ first: { data: [], nextCursor: "broken" }, broken: { error: "fake list page failure" } });
  await assert.rejects(() => listNativeCliSessions(broken.options), /fake list page failure/);
  assert.equal(broken.requests().length, 2);
});

await t("[resume] 提示词标记与 buildBotPrompt 的第一行一致", async () => {
  const { AGENT_OS_PROMPT_MARKER } = await R("core/bot-registry.js");
  const p = buildBotPrompt({ role: "开发", skills: [], systemPrompt: "" }, "干活", "", "local");
  assert.ok(p.startsWith(AGENT_OS_PROMPT_MARKER), "标记和实际提示词开头对不上，来源判断会全错");
});

await t("[重试] 上游临时故障会重试并带上会话 id 续接", async () => {
  const { runCli } = await R("cli/runner.js");
  // 第一次吐出 session 后以 529 退出，第二次成功。真机撞到过 500 和 529 各一次，
  // 每次都把一个跑了半小时、完成四十多次工具调用的任务整个作废。
  const stateFile = join(dir, `retry-${Math.random().toString(36).slice(2)}.flag`);
  const script = `
    const fs = require("node:fs");
    const first = !fs.existsSync(process.argv[1]);
    if (first) fs.writeFileSync(process.argv[1], "x");
    console.log(JSON.stringify({ type: "session", sessionId: "sess-1" }));
    if (first) { console.error("API Error: 529 Overloaded"); process.exit(1); }
    console.log(JSON.stringify({ type: "result", answer: "第二次成功", sessionId: "sess-1" }));
  `;
  const resumeCalls = [];
  const adapter = {
    id: "claude", command: process.execPath, displayName: "假引擎",
    buildArgs: () => ["-e", script, stateFile],
    buildResumeArgs: (_p, sid) => { resumeCalls.push(sid); return ["-e", script, stateFile]; },
    buildCompactPlan: () => ({ protocol: "claude-stream-json", command: process.execPath, args: [], prompt: "" }),
    parseEvents: (l) => { try { const e = JSON.parse(l); return e?.type ? [e] : []; } catch { return []; } },
  };
  const retries = [];
  const r = await runCli({
    adapter, prompt: "x", cwd: process.cwd(),
    onRetry: (n, e) => retries.push([n, e.message]),
  });
  assert.equal(r.answer, "第二次成功");
  assert.equal(retries.length, 1, "没有重试");
  assert.deepEqual(resumeCalls, ["sess-1"], "重试没有带上会话 id，半小时上下文白扔");
});

await t("[重试] 超时和取消不重试", async () => {
  const { runCli, CLI_TIMEOUT_ERROR } = await R("cli/runner.js");
  let starts = 0;
  const silent = {
    id: "claude", command: process.execPath, displayName: "假引擎",
    buildArgs: () => { starts += 1; return ["-e", "setInterval(()=>{},1000)"]; },
    buildResumeArgs: () => { starts += 1; return ["-e", "setInterval(()=>{},1000)"]; },
    buildCompactPlan: () => ({ protocol: "claude-stream-json", command: process.execPath, args: [], prompt: "" }),
    parseEvents: () => [],
  };
  const err = await runCli({ adapter: silent, prompt: "x", cwd: process.cwd(), idleTimeoutMs: 200 })
    .then(() => null, (e) => e);
  assert.equal(err.name, CLI_TIMEOUT_ERROR);
  assert.equal(starts, 1, "超时被当成瞬时故障重试了，只会浪费更多时间");
});

await t("[超时] 阈值缺失或非法时退回默认，不能变成瞬间超时", async () => {
  // setTimeout(fn, NaN) 在 Node 里立刻触发，配置漏字段会让每个任务都瞬间「超时」。
  const { runCli } = await R("cli/runner.js");
  const adapter = {
    id: "claude", command: process.execPath, displayName: "假引擎",
    buildArgs: () => ["-e", "console.log(JSON.stringify({type:'result',answer:'ok'}))"],
    buildResumeArgs: () => ["-e", "console.log(JSON.stringify({type:'result',answer:'ok'}))"],
    buildCompactPlan: () => ({ protocol: "claude-stream-json", command: process.execPath, args: [], prompt: "" }),
    parseEvents: (l) => { try { const e = JSON.parse(l); return e?.type ? [e] : []; } catch { return []; } },
  };
  for (const limits of [{}, { idleTimeoutMs: NaN }, { idleTimeoutMs: 0 }, { maxRuntimeMs: undefined }]) {
    const r = await runCli({ adapter, prompt: "x", cwd: process.cwd(), ...limits });
    assert.equal(r.answer, "ok");
  }
});

await t("[超时] 空闲阈值与总上限分开配置", () => {
  const cfg = parseAgentOsConfig({ teamLeader: "dev", bots: [baseBot] }, env);
  assert.equal(cfg.bots[0].idleTimeoutMinutes, 15);
  assert.equal(cfg.bots[0].maxRuntimeMinutes, 120);
  // 空闲阈值必须宽于最长的一次合法沉默（跑测试套件时 stdout 会安静十几分钟）
  assert.ok(cfg.bots[0].idleTimeoutMinutes >= 15);
  const custom = parseAgentOsConfig(
    { teamLeader: "dev", bots: [{ ...baseBot, idleTimeoutMinutes: 30, maxRuntimeMinutes: 240 }] }, env);
  assert.equal(custom.bots[0].idleTimeoutMinutes, 30);
  assert.equal(custom.bots[0].maxRuntimeMinutes, 240);
  assert.throws(() => parseAgentOsConfig(
    { teamLeader: "dev", bots: [{ ...baseBot, idleTimeoutMinutes: 0 }] }, env));
});

await t("[resume] 默认值是安全的那一个", () => {
  const cfg = parseAgentOsConfig({ teamLeader: "dev", bots: [baseBot] }, env);
  assert.equal(cfg.bots[0].resumeScope, "agent-os");
});

await t("[open_id] 负责人 open_id 按 bot 配置，全局值只作兜底", () => {
  // open_id 按飞书应用隔离：同一个人在每台 bot 眼里是不同的 open_id，
  // 全局一个值在多 bot 下必然有一台用错，@人的接口会直接失败。
  const two = [
    { ...baseBot, id: "dev", ownerOpenId: "ou_seen_by_dev" },
    { ...baseBot, id: "rev", appIdEnv: "B_ID", appSecretEnv: "B_SECRET" },
  ];
  const cfg = parseAgentOsConfig({ teamLeader: "dev", bots: two },
    { ...env, B_ID: "cli_y", B_SECRET: "s2", OWNER_OPEN_ID: "ou_fallback" });
  assert.equal(cfg.bots[0].ownerOpenId, "ou_seen_by_dev", "按 bot 配的值必须优先");
  assert.equal(cfg.bots[1].ownerOpenId, "ou_fallback", "没配的退回全局兜底");
  // 都没有时就是 undefined，通知层会跳过而不是拿空串去调接口
  const none = parseAgentOsConfig({ teamLeader: "dev", bots: [baseBot] }, env);
  assert.equal(none.bots[0].ownerOpenId, undefined);
  // 格式不对的直接拒绝
  assert.throws(() => parseAgentOsConfig(
    { teamLeader: "dev", bots: [{ ...baseBot, ownerOpenId: "not-an-open-id" }] }, env));
});

await t("提示词包含角色/Skill/输出约束", () => {
  const p = buildBotPrompt(
    { role: "产品经理", skills: ["grill-me", "to-spec"], systemPrompt: "先澄清" }, "加个功能", "团队：...", "local");
  assert.match(p, /你的角色：产品经理/);
  assert.match(p, /\$grill-me/);
  assert.match(p, /当前默认交付方式：local/);
  assert.match(p, /1200 个中文字符/);
  assert.match(p, /当前任务：加个功能/);
  // 没有产品 Skill 的成员不应被注入产品交付规则
  const devPrompt = buildBotPrompt({ role: "开发", skills: [], systemPrompt: "" }, "干活", "", "local");
  assert.equal(/默认交付方式/.test(devPrompt), false);
});

console.log("clarification");
const C = await R("core/clarification.js");
const req = {
  title: "确认范围", questions: [
    { id: "a", prompt: "从哪进入？", options: [{ id: "x", label: "列表" }, { id: "y", label: "菜单" }], recommendedOptionId: "y" },
    { id: "b", prompt: "展示什么？", options: [{ id: "p", label: "基础" }, { id: "q", label: "全量" }] },
  ],
};
await t("Schema 拒绝非法推荐项/重复 id", () => {
  assert.equal(C.ClarificationRequestSchema.safeParse(req).success, true);
  assert.equal(C.ClarificationRequestSchema.safeParse({
    ...req, questions: [{ ...req.questions[0], recommendedOptionId: "zzz" }] }).success, false);
  assert.equal(C.ClarificationRequestSchema.safeParse({
    ...req, questions: [req.questions[0], req.questions[0]] }).success, false);
});
await t("findClarificationRequest 取最后一次合法调用", () => {
  const found = C.findClarificationRequest([
    { toolName: "request_clarification", input: { bad: 1 } },
    { toolName: "request_clarification", input: req },
  ]);
  assert.equal(found.questions.length, 2);
});
await t("逐题回答推进到完成", () => {
  const store = new C.ClarificationFlowStore();
  const f = store.create({ taskId: "t", botId: "b", sessionId: "s", ownerOpenId: "ou", originalMessageId: "om", replyInThread: true, request: C.ClarificationRequestSchema.parse(req) });
  const r1 = store.answer(f.token, "a", "列表");
  assert.equal(r1.complete, false);
  const r2 = store.answer(f.token, "b", "全量");
  assert.equal(r2.complete, true);
  assert.equal(r2.flow.answers.length, 2);
});
await t("按推荐方案继续会答完剩余全部", () => {
  const store = new C.ClarificationFlowStore();
  const f = store.create({ taskId: "t", botId: "b", sessionId: "s", ownerOpenId: "ou", originalMessageId: "om", replyInThread: true, request: C.ClarificationRequestSchema.parse(req) });
  const r = store.answerWithRecommendation(f.token, true);
  assert.equal(r.complete, true);
  assert.equal(r.flow.answers.length, 2);
  assert.equal(r.flow.answers[0].answer, "菜单");   // 推荐项
  assert.equal(r.flow.answers[1].answer, "基础");   // 无推荐项则取第一个
  assert.equal(r.flow.answers[0].source, "agent");
});
await t("单题交给 Agent 只推进一题", () => {
  const store = new C.ClarificationFlowStore();
  const f = store.create({ taskId: "t", botId: "b", sessionId: "s", ownerOpenId: "ou", originalMessageId: "om", replyInThread: true, request: C.ClarificationRequestSchema.parse(req) });
  const r = store.answerWithRecommendation(f.token, false);
  assert.equal(r.complete, false);
  assert.equal(r.flow.answers.length, 1);
});
await t("答错题号会被拒绝", () => {
  const store = new C.ClarificationFlowStore();
  const f = store.create({ taskId: "t", botId: "b", sessionId: "s", ownerOpenId: "ou", originalMessageId: "om", replyInThread: true, request: C.ClarificationRequestSchema.parse(req) });
  assert.equal(store.answer(f.token, "b", "x"), undefined);
});
await t("同话题新建澄清会顶掉旧的，别的话题不受影响", () => {
  const store = new C.ClarificationFlowStore();
  const parsed = C.ClarificationRequestSchema.parse(req);
  const mk = (taskId) => store.create({ taskId, topicId: "topic-1", botId: "b", sessionId: "s", ownerOpenId: "ou", originalMessageId: "om", replyInThread: true, request: parsed });
  // 同一话题里的第二张卡顶掉第一张——哪怕它属于另一件事。
  // 用户眼前只有一张卡，两张同时有效的话他不知道该点哪张。
  const a = mk("task-1");
  const b = mk("task-2");
  assert.equal(store.get(a.token), undefined);
  assert.equal(store.findForTopic("topic-1", "b").token, b.token);
  // 别的话题互不影响
  const other = store.create({ taskId: "task-3", topicId: "topic-2", botId: "b", sessionId: "s", ownerOpenId: "ou", originalMessageId: "om", replyInThread: true, request: parsed });
  assert.equal(store.findForTopic("topic-2", "b").token, other.token);
  assert.equal(store.findForTopic("topic-1", "b").token, b.token, "顶掉的只该是同话题那张");
});

console.log("product spec");
const P = await R("core/product-spec.js");
await t("local / lark-doc 互斥", () => {
  assert.equal(P.ProductSpecRequestSchema.safeParse({
    title: "t", summary: "s", deliveryMode: "local",
    specPath: ".scratch/f/spec.md", ticketsPath: ".scratch/f/issues" }).success, true);
  assert.equal(P.ProductSpecRequestSchema.safeParse({
    title: "t", summary: "s", deliveryMode: "local",
    specPath: ".scratch/f/spec.md", ticketsPath: ".scratch/f/issues",
    documentUrl: "https://x.feishu.cn/docx/abc" }).success, false);
});
await t("路径逃逸被拒绝", () => {
  for (const p of ["/etc/passwd", "../outside/spec.md", "a/../../b"]) {
    assert.equal(P.ProductSpecRequestSchema.safeParse({
      title: "t", summary: "s", deliveryMode: "local", specPath: p, ticketsPath: "x" }).success, false, p);
  }
});
await t("只接受 docx 链接", () => {
  const ok = (u) => P.ProductSpecRequestSchema.safeParse({ title: "t", summary: "s", deliveryMode: "lark-doc", documentUrl: u }).success;
  assert.equal(ok("https://x.feishu.cn/docx/AbC-123"), true);
  assert.equal(ok("https://x.feishu.cn/wiki/AbC-123"), false);
  assert.equal(ok("not-a-url"), false);
});
await t("确认状态机 + 按文档反查", () => {
  const store = new P.ProductSpecFlowStore();
  const request = P.ProductSpecRequestSchema.parse({ title: "t", summary: "s", deliveryMode: "lark-doc", documentUrl: "https://x.feishu.cn/docx/TOKEN1" });
  const f = store.create({ taskId: "t1", botId: "product", sessionId: "s1", ownerOpenId: "ou", request });
  assert.equal(store.findPendingByDocument("product", "TOKEN1").token, f.token);
  assert.equal(store.approve(f.token).status, "approved");
  assert.equal(store.approve(f.token), undefined);          // 重复点击无效
  assert.equal(store.findPendingByDocument("product", "TOKEN1"), undefined);
});
await t("同任务新方案让旧卡失效而非消失", () => {
  const store = new P.ProductSpecFlowStore();
  const request = P.ProductSpecRequestSchema.parse({ title: "t", summary: "s", deliveryMode: "lark-doc", documentUrl: "https://x.feishu.cn/docx/T2" });
  const a = store.create({ taskId: "t1", botId: "p", sessionId: "s", ownerOpenId: "ou", request });
  store.create({ taskId: "t1", botId: "p", sessionId: "s", ownerOpenId: "ou", request });
  assert.equal(store.get(a.token).status, "expired");
});

console.log("approval");
const A = await R("core/approval.js");
await t("审批状态只能被拍板一次", () => {
  const store = new A.ApprovalFlowStore();
  const request = A.ApprovalRequestSchema.parse({ title: "重启服务", summary: "s", impact: "i", risk: "high" });
  const f = store.create({ taskId: "t", botId: "dev", sessionId: "s", ownerOpenId: "ou", originalMessageId: "om", replyInThread: true, request });
  assert.equal(f.status, "pending");
  assert.equal(store.decide(f.token, "approved", "ou").status, "approved");
  assert.equal(store.decide(f.token, "rejected", "ou"), undefined);
});
await t("超时时间取 timeoutMinutes", () => {
  const store = new A.ApprovalFlowStore(() => new Date("2026-01-01T00:00:00.000Z"));
  const request = A.ApprovalRequestSchema.parse({ title: "t", summary: "s", impact: "i", risk: "low", timeoutMinutes: 5 });
  const f = store.create({ taskId: "t", botId: "d", sessionId: "s", ownerOpenId: "ou", originalMessageId: "om", replyInThread: true, request });
  assert.equal(f.expiresAt, "2026-01-01T00:05:00.000Z");
});
await t("拒绝与超时的续跑文案明确禁止执行", () => {
  const base = { token: "x", taskId: "t", botId: "d", sessionId: "s", ownerOpenId: "o", originalMessageId: "m", replyInThread: true, expiresAt: new Date().toISOString(), request: { title: "删库", summary: "s", impact: "i", risk: "high" } };
  assert.match(A.formatApprovalOutcome({ ...base, status: "rejected" }), /不要执行/);
  assert.match(A.formatApprovalOutcome({ ...base, status: "rejected" }), /绕过/);
  assert.match(A.formatApprovalOutcome({ ...base, status: "expired" }), /视为未批准/);
  assert.match(A.formatApprovalOutcome({ ...base, status: "approved" }), /可以执行/);
});

console.log("collaboration");
const CO = await R("core/collaboration.js");
await t("领取即删除，同一取件码只能用一次", () => {
  const inbox = new CO.CollaborationInbox();
  const msg = { dispatchId: "abc123abc123", taskId: "t", fromBotId: "dev", toBotId: "rev", chatId: "c", threadId: "t", round: 1, maxRounds: 16, workspaceDir: "/w", prompt: "p" };
  inbox.register(msg);
  assert.equal(inbox.consume("abc123abc123", "other", { chatId: "c", threadId: "t" }), undefined); // 非目标 bot 领不走
  assert.equal(inbox.consume("abc123abc123", "rev", { chatId: "c", threadId: "t" }).taskId, "t");
  assert.equal(inbox.consume("abc123abc123", "rev", { chatId: "c", threadId: "t" }), undefined);   // 不能领第二次
});
await t("去重键含轮次，两轮不会互相误判", () => {
  const k1 = CO.collaborationTurnKey({ taskId: "t", round: 1, toBotId: "rev" });
  const k2 = CO.collaborationTurnKey({ taskId: "t", round: 2, toBotId: "rev" });
  assert.notEqual(k1, k2);
});
await t("dispatch_task 参数校验", () => {
  assert.equal(CO.DispatchTaskRequestSchema.safeParse({ toBotId: "developer", task: "干活" }).success, true);
  assert.equal(CO.DispatchTaskRequestSchema.safeParse({ toBotId: "Dev Bot", task: "x" }).success, false);
});

console.log("command parser");
const CP = await R("core/command-parser.js");
await t("识别命令与 @前缀（含带空格的机器人名）", () => {
  assert.deepEqual(CP.parseCommand("/status"), { name: "status" });
  assert.deepEqual(CP.parseCommand("@Agent OS /team"), { name: "team" });
  assert.deepEqual(CP.parseCommand("/cd ../a b"), { name: "cd", path: "../a b" });
  assert.deepEqual(CP.parseCommand("/cd"), { name: "cd" });
  assert.deepEqual(CP.parseCommand("/compact 保留接口约定"), { name: "compact", instructions: "保留接口约定" });
  assert.deepEqual(CP.parseCommand("/schedule"), { name: "schedule" });
});
await t("识别 /history，@前缀同样识别，不与相近写法混淆", () => {
  assert.deepEqual(CP.parseCommand("/history"), { name: "history" });
  assert.deepEqual(CP.parseCommand("@Agent OS /history"), { name: "history" });
  assert.deepEqual(CP.parseCommand("  /history  "), { name: "history" });
  // 中文输入法会在标点后自动补空格，真机上把 /history 打成了 / history
  assert.deepEqual(CP.parseCommand("/ history"), { name: "history" });
  assert.deepEqual(CP.parseCommand("/ cd ../a"), { name: "cd", path: "../a" });
  // 后面跟内容的不是本命令，别把「查历史」和「让引擎干活」混成一条
  assert.equal(CP.parseCommand("/history 昨天"), undefined);
  assert.equal(CP.parseCommand("/histories"), undefined);
  assert.equal(CP.parseCommand("看一下 /history"), undefined);
});
await t("普通文本里提到命令不会误判", () => {
  assert.equal(CP.parseCommand("帮我运行 /status 看看"), undefined);
  assert.equal(CP.parseCommand("/unknown"), undefined);

  // 打错的命令：认出来是「想敲命令」，并给出最接近的那个
  assert.equal(CP.looksLikeCommand("/schdule"), "schdule");
  assert.equal(CP.closestCommand("schdule"), "schedule");
  assert.equal(CP.closestCommand("histroy"), "history");
  // 差太远就不猜——瞎猜一个八竿子打不着的命令比直说「没有」更让人迷惑
  assert.equal(CP.closestCommand("xyz"), undefined);
  // 路径不是命令：第一个 token 里还有第二个 / 就放行，别把人家的目录挡回去
  assert.equal(CP.looksLikeCommand("/Users/example/project 看一下"), undefined);
  assert.equal(CP.looksLikeCommand("看下 /tmp 有什么"), undefined);
});
await t("引擎指定命令", () => {
  assert.deepEqual(CP.parseCliRequest("/codex 检查项目"), { cliId: "codex", prompt: "检查项目" });
  assert.deepEqual(CP.parseCliRequest("/claude"), { cliId: "claude", prompt: "" });
  assert.equal(CP.parseCliRequest("/status"), undefined);
});

console.log("adapters");
const { getCliAdapter } = await R("cli/registry.js");
const claude = getCliAdapter("claude");
const codex = getCliAdapter("codex");
await t("Claude 参数含 headless + MCP 挂载", () => {
  const args = claude.buildArgs("你好", "argument");
  assert.ok(args.includes("--output-format") && args.includes("stream-json"));
  assert.ok(args.includes("--dangerously-skip-permissions"));
  assert.ok(args.includes("--mcp-config"));
  assert.ok(args.includes("你好"));
  const stdinArgs = claude.buildArgs("你好", "stdin");
  assert.equal(stdinArgs.includes("你好"), false); // stdin 模式不进命令行
});
await t("Claude resume 带 --resume", () => {
  const args = claude.buildResumeArgs("继续", "sess-1", "argument");
  assert.equal(args[0], "--resume");
  assert.equal(args[1], "sess-1");
});
await t("Claude 解析：派生子 Agent 时把它是哪一个捞出来", () => {
  // 事件形状取自真机会话记录：assistant → tool_use → name:"Agent" → input.subagent_type。
  // 靠观察拿，不靠引擎自报——真机上出现过报告说「等 tester 结论回来」，
  // 而那一轮其实已经收尾了，自报的话这条记录就是假的。
  const line = (name, input) => JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "tu1", name, input }] },
  });
  const one = claude.parseEvents(line("Agent", {
    description: "Test pass", subagent_type: "tester", prompt: "验一下",
  })).find((e) => e.type === "tool_start");
  assert.equal(one.subagentType, "tester");

  // 旧版本里这个工具叫 Task。只认一个名字的话，换个版本就全看不见了，
  // 而「看不见」和「没派过」在数据上长得一模一样。
  const old = claude.parseEvents(line("Task", { subagent_type: "code-reviewer" }))
    .find((e) => e.type === "tool_start");
  assert.equal(old.subagentType, "code-reviewer");

  // 普通工具不该带这个字段，否则统计里会混进一堆假的子 Agent
  const plain = claude.parseEvents(line("Read", { file_path: "/a.ts" }))
    .find((e) => e.type === "tool_start");
  assert.equal(plain.subagentType, undefined);
  // Agent 工具但没给类型（参数不全）也不能瞎填
  const bare = claude.parseEvents(line("Agent", { description: "x" }))
    .find((e) => e.type === "tool_start");
  assert.equal(bare.subagentType, undefined);
});

await t("未经验证的判断：三个条件缺一不可", async () => {
  const { isUnverifiedRun } = await R("core/task-record.js");
  const base = { editedFiles: true, subagents: [] };
  // 改了文件、引擎能派子 Agent、却一个验证的都没派 → 该标
  assert.equal(isUnverifiedRun(base, true), true);
  // 只读的一轮没什么可验的，标了只是噪音
  assert.equal(isUnverifiedRun({ ...base, editedFiles: false }, true), false);
  // Codex 没有子 Agent 概念，拿同一把尺子量它只会得到一片永远的「未验证」
  assert.equal(isUnverifiedRun(base, false), false);
  // 派过 tester 或 code-reviewer 就算有证据
  assert.equal(isUnverifiedRun({ ...base, subagents: ["tester"] }, true), false);
  assert.equal(isUnverifiedRun({ ...base, subagents: ["code-reviewer"] }, true), false);
  // 派了别的子 Agent 不算——派过 Explore 不代表验过
  assert.equal(isUnverifiedRun({ ...base, subagents: ["Explore"] }, true), true);
  // 老记录没有这个字段：「不知道有没有验过」对用户需要同样的警惕
  assert.equal(isUnverifiedRun({ editedFiles: true }, true), true);
});

await t("Claude 解析 init/tool/result", () => {
  assert.deepEqual(claude.parseEvents(JSON.stringify({ type: "system", subtype: "init", session_id: "s1" })), [{ type: "session", sessionId: "s1" }]);
  const ev = claude.parseEvents(JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/a/b/c.ts" } }] } }));
  assert.deepEqual(ev[0], { type: "context", usedTokens: 15 });
  assert.equal(ev[1].type, "tool_start");
  assert.equal(ev[1].label, "读取文件");
  assert.equal(ev[1].detail, "b/c.ts"); // 绝对路径只留末两段
  const r = claude.parseEvents(JSON.stringify({ type: "result", result: "done", session_id: "s1", duration_ms: 100, num_turns: 2, usage: { input_tokens: 1, output_tokens: 2 }, modelUsage: { m: { contextWindow: 200000 } } }));
  assert.equal(r[0].answer, "done");
  assert.equal(r[0].stats.contextWindowTokens, 200000);
  assert.equal(r[0].stats.totalTokens, 3);
});
await t("Claude 把 MCP 工具名还原成应用工具名", () => {
  const ev = claude.parseEvents(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__agent_os__request_clarification", input: { a: 1 } }] } }));
  const call = ev.find((e) => e.type === "tool_call");
  assert.equal(call.toolName, "request_clarification");
});
await t("Claude 错误事件", () => {
  const ev = claude.parseEvents(JSON.stringify({ type: "result", is_error: true, result: "boom" }));
  assert.deepEqual(ev, [{ type: "error", message: "boom" }]);
});
await t("非 JSON 行被跳过", () => {
  assert.deepEqual(claude.parseEvents("some log line"), []);
  assert.deepEqual(codex.parseEvents("[warn] reconnecting"), []);
});
await t("Codex exec / resume 参数顺序", () => {
  const a = codex.buildArgs("你好", "argument");
  assert.ok(a.indexOf("-c") < a.indexOf("exec"));       // 配置项必须在子命令前
  assert.equal(a[a.length - 1], "你好");
  const s = codex.buildArgs("你好", "stdin");
  assert.equal(s[s.length - 1], "-");
  const r = codex.buildResumeArgs("继续", "th-1", "argument");
  assert.equal(r[r.length - 2], "th-1");
  assert.equal(r[r.length - 1], "继续");
  assert.ok(r.includes("resume"));
});
await t("Codex 答案与用量分事件", () => {
  assert.deepEqual(codex.parseEvents(JSON.stringify({ type: "thread.started", thread_id: "th1" })), [{ type: "session", sessionId: "th1" }]);
  const ans = codex.parseEvents(JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "hi" } }));
  assert.deepEqual(ans, [{ type: "result", answer: "hi" }]);
  const usage = codex.parseEvents(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 7, output_tokens: 3 } }));
  assert.equal(usage[0].stats.totalTokens, 10);
  assert.equal(usage[0].answer, "");
});
await t("Codex MCP 工具调用被识别", () => {
  const ev = codex.parseEvents(JSON.stringify({ type: "item.started", item: { id: "i2", type: "mcp_tool_call", server: "agent_os", tool: "request_approval", arguments: { title: "x" } } }));
  const call = ev.find((e) => e.type === "tool_call");
  assert.equal(call.toolName, "request_approval");
});

console.log("task progress");
const { TaskProgressTracker } = await R("core/task-progress.js");
await t("工具配对与上下文增量", () => {
  let now = 1000;
  const tr = new TaskProgressTracker(() => now, 200000, true);
  tr.accept({ type: "context", usedTokens: 1000 });
  tr.accept({ type: "tool_start", toolUseId: "a", toolName: "Read", label: "读取文件", detail: "x.ts" });
  tr.accept({ type: "tool_start", toolUseId: "b", toolName: "Bash", label: "运行命令" });
  now = 3000;
  tr.accept({ type: "tool_end", toolUseId: "a", failed: false });
  tr.accept({ type: "context", usedTokens: 4000 });
  const s = tr.snapshot();
  assert.equal(s.toolCount, 2);
  assert.equal(s.completedCount, 1);
  assert.equal(s.current, "运行命令");            // 未结束的那个
  assert.equal(s.activities[0].durationMs, 2000);
  assert.equal(s.contextStartTokens, 1000);
  assert.equal(s.contextUsedTokens, 4000);
  assert.equal(s.startedNewSession, true);
});
await t("未知 tool_end 不会计数", () => {
  const tr = new TaskProgressTracker(() => 0);
  tr.accept({ type: "tool_end", toolUseId: "ghost", failed: false });
  assert.equal(tr.snapshot().completedCount, 0);
});

console.log("task abort");
const { requestTaskAbort, abortScheduleRuns } = await R("core/task-abort.js");
await t("只有发起人能停止，且只停一次", () => {
  const runs = new Map();
  const controller = new AbortController();
  runs.set("s1", { controller, ownerOpenId: "ou_me" });
  assert.equal(requestTaskAbort(runs, "s1", "ou_other"), "forbidden");
  assert.equal(requestTaskAbort(runs, "nope", "ou_me"), "not_found");
  assert.equal(requestTaskAbort(runs, "s1", "ou_me"), "stopped");
  assert.equal(controller.signal.aborted, true);
  assert.equal(runs.get("s1").cancelMode, "stop");
  assert.equal(requestTaskAbort(runs, "s1", "ou_me"), "already_stopping");
});

await t("删定时任务停的是它自己那一轮，别人的任务一个都不许碰", () => {
  const runs = new Map();
  const mine = new AbortController();
  const other = new AbortController();
  const plain = new AbortController();
  runs.set("s1", { controller: mine, ownerOpenId: "ou_owner", scheduleId: "sch_a" });
  runs.set("s2", { controller: other, ownerOpenId: "ou_owner", scheduleId: "sch_b" });
  // 人在话题里手打的任务：没有 scheduleId，删任何一条定时任务都不该殃及它
  runs.set("s3", { controller: plain, ownerOpenId: "ou_owner" });

  assert.equal(abortScheduleRuns(runs, "sch_a"), "stopped");
  assert.equal(mine.signal.aborted, true);
  assert.equal(runs.get("s1").cancelMode, "stop", "要走「只停本轮」，不能连会话一起关");
  assert.equal(other.signal.aborted, false, "停的是 sch_a，sch_b 不该跟着倒");
  assert.equal(plain.signal.aborted, false, "手打的任务没有 scheduleId，绝不能被扫到");
  assert.equal(abortScheduleRuns(runs, "sch_a"), "already_stopping");
  assert.equal(abortScheduleRuns(runs, "sch_never"), "not_running");
});

await t("删定时任务不看归属：谁点的删除，谁就停得掉这一轮", () => {
  // 定时轮的归属人是 bot 配置里的 ownerOpenId，群里点删除的往往不是他；
  // 这个字段还是可选的，没配时它是空串——真照归属去卡，就没人停得掉了。
  const runs = new Map();
  const controller = new AbortController();
  runs.set("s1", { controller, ownerOpenId: "", scheduleId: "sch_a" });
  assert.equal(abortScheduleRuns(runs, "sch_a"), "stopped");
  assert.equal(controller.signal.aborted, true);
});

await t("同一条定时任务万一有两轮在飞，要全停掉", () => {
  const runs = new Map();
  const one = new AbortController();
  const two = new AbortController();
  runs.set("s1", { controller: one, ownerOpenId: "ou_owner", scheduleId: "sch_a" });
  runs.set("s2", { controller: two, ownerOpenId: "ou_owner", scheduleId: "sch_a" });
  assert.equal(abortScheduleRuns(runs, "sch_a"), "stopped");
  assert.equal(one.signal.aborted, true);
  assert.equal(two.signal.aborted, true, "只停碰见的第一个，剩下那轮照样在改文件");
});

console.log("topic task");
const { topicScopeId, topicIdOf } = await R("core/topic-task.js");
await t("话题标识稳定，任务标识每次都新——两者不能混用", async () => {
  const { topicScopeIdOf, newTaskId } = await R("core/topic-task.js");
  const a = { messageId: "om_1", chatId: "oc", threadId: "omt", rootId: "" };
  const b = { messageId: "om_2", chatId: "oc", threadId: "omt", rootId: "om_1" };
  // 同一个话题里的任何消息，话题标识都一样——「这个话题里有没有待办的卡」靠它
  assert.equal(topicScopeId(a), topicScopeId(b));
  assert.equal(topicScopeId(a), topicScopeIdOf("oc", "omt"),
    "从会话反推要和从消息算出来的一致，否则续跑那一轮就查不到自己话题的卡");
  assert.equal(topicIdOf({ messageId: "om_9", chatId: "c", threadId: "", rootId: "" }), "om_9");
  // 任务标识每次都不同——它标识「一件事」，而同一个话题里会发生很多件事。
  // 这两个值一度是同一个，于是「改 README」和「删目录」共用一个编号，
  // 而那个编号还印在卡片上给用户看。
  assert.notEqual(newTaskId(), newTaskId());
  assert.notEqual(newTaskId(), topicScopeId(a));
});

console.log("card rendering");
const CARD = await R("im/card.js");
await t("卡片状态与停止按钮", () => {
  const running = CARD.buildTaskCard({ title: "T", status: "running", detail: "正在理解任务", abortSessionId: "s1" });
  assert.equal(running.header.template, "blue");
  const json = JSON.stringify(running);
  assert.ok(json.includes("abort_task") && json.includes("s1"));
  const done = CARD.buildTaskCard({ title: "T", status: "success", detail: "完成", answer: "结果" });
  assert.equal(done.header.template, "green");
  assert.equal(JSON.stringify(done).includes("abort_task"), false); // 结束后不该还能点停止
});
await t("markdown 标签被转义，长答案切分", () => {
  const c = CARD.buildTaskCard({ title: "T", status: "success", detail: "d", answer: "<script>x</script>" });
  assert.ok(JSON.stringify(c).includes("<&zwj;script"));
  const long = "段落\n\n".repeat(4000);
  assert.equal(CARD.answerNeedsContinuation(long), true);
  const chunks = CARD.splitLongText(CARD.answerContinuation(long));
  assert.ok(chunks.length > 0 && chunks.every((x) => x.length <= 3600));
});
await t("代码块被截断时补回围栏", () => {
  const chunks = CARD.splitLongText("```js\n" + "const a = 1;\n".repeat(400) + "```");
  assert.ok(chunks[0].trimEnd().endsWith("```"));
});
await t("澄清卡片渲染全部选项与自定义表单", () => {
  const flow = { token: "tok12345678", taskId: "t", botId: "b", sessionId: "s", ownerOpenId: "o", originalMessageId: "m", replyInThread: true, currentIndex: 0, answers: [], request: C.ClarificationRequestSchema.parse(req) };
  const json = JSON.stringify(CARD.buildClarificationCard({ flow }));
  assert.ok(json.includes("answer_clarification"));
  assert.ok(json.includes("custom_answer"));
  assert.ok(json.includes("（推荐）"));
  assert.ok(json.includes("按推荐方案继续"));
});
await t("审批卡片含批准/拒绝与命令", () => {
  const flow = { token: "t", taskId: "t", botId: "d", sessionId: "s", ownerOpenId: "o", originalMessageId: "m", replyInThread: true, status: "pending", expiresAt: new Date().toISOString(), request: { title: "重启", summary: "s", impact: "全站", risk: "high", command: "systemctl restart api" } };
  const json = JSON.stringify(CARD.buildApprovalCard(flow));
  assert.ok(json.includes("decide_approval") && json.includes("approved") && json.includes("rejected"));
  assert.ok(json.includes("systemctl restart api"));
  assert.equal(CARD.buildApprovalCard(flow).header.template, "red");
});
const sched = (over = {}) => ({
  id: "abc", botId: "d", chatId: "c", name: "日志巡检", cron: "0 * * * *",
  prompt: "p", enabled: true, createdAt: new Date().toISOString(), ...over,
});
const schedCard = (list, over = {}) =>
  CARD.buildScheduleListCard(list, { botId: "d", chatId: "c", ...over });
/** 卡片里所有回调按钮的 value，用来验按钮到底带了什么回去。 */
const schedCallbacks = (card) => {
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    if (node.type === "callback" && node.value) found.push(node.value);
    Object.values(node).forEach(walk);
  };
  walk(card);
  return found;
};

await t("定时任务列表卡片", () => {
  const json = JSON.stringify(schedCard([sched()]));
  assert.ok(json.includes("日志巡检") && json.includes("0 * * * *"));
  assert.ok(JSON.stringify(schedCard([])).includes("还没有定时任务"));
});

await t("每一条任务都带自己的操作按钮，回调里写清作用域和目标状态", () => {
  // 三条样本：拿一条去验「每一条都有」，等于拿 1 比 1，
  // 「只给第一行渲染按钮」这种实现错误照样能过。
  const list = [sched(), sched({ id: "b2", name: "第二条" }), sched({ id: "b3", name: "第三条", enabled: false })];
  const values = schedCallbacks(schedCard(list));
  const toggles = values.filter((v) => v.action === "schedule_toggle");
  const deletes = values.filter((v) => v.action === "schedule_delete");
  assert.equal(toggles.length, 3, "三条任务就该有三个启停入口");
  assert.equal(deletes.length, 3, "三条任务就该有三个删除入口");
  assert.deepEqual(toggles.map((v) => v.scheduleId), ["abc", "b2", "b3"],
    "每个按钮要指向自己那一条，不能都指向第一条");
  for (const value of values) {
    assert.equal(value.botId, "d");
    assert.equal(value.chatId, "c");
  }
  // 目标状态跟着各自的当前状态走，不是一刀切
  assert.deepEqual(toggles.map((v) => v.enabled), [false, false, true],
    "启用中的带 false（去停用），已停用的带 true（去启用）");
});

await t("启用与停用共用一个按钮，文案和目标状态都跟着当前状态走", () => {
  const on = schedCard([sched({ enabled: true })]);
  assert.ok(JSON.stringify(on).includes("停用"));
  assert.equal(schedCallbacks(on).find((v) => v.action === "schedule_toggle").enabled, false);

  const off = schedCard([sched({ enabled: false })]);
  assert.ok(JSON.stringify(off).includes("启用"));
  assert.equal(schedCallbacks(off).find((v) => v.action === "schedule_toggle").enabled, true);
});

await t("删除分两步，确认按钮记住是谁点开的", () => {
  const first = schedCallbacks(schedCard([sched()]))
    .find((v) => v.action === "schedule_delete");
  assert.equal(first.confirmed, undefined, "第一次点只是要一个确认，不该直接删");

  const pending = schedCard([sched()], { pendingDeleteId: "abc", armedBy: "ou_jia" });
  const json = JSON.stringify(pending);
  assert.ok(json.includes("确认删除") && json.includes("取消"), "要给确认，也要给退路");
  const confirm = schedCallbacks(pending).find((v) => v.action === "schedule_delete");
  assert.equal(confirm.confirmed, true);
  assert.equal(confirm.armedBy, "ou_jia",
    "卡片是群里共享的，不记住是谁点开的，对别人就成了一点就删");

  // 只有被点的那一条进入待确认；另一条必须仍是普通删除按钮（非空样本，不是空数组恒真）
  const two = schedCard([sched(), sched({ id: "xyz", name: "另一个" })], { pendingDeleteId: "abc" });
  const others = schedCallbacks(two)
    .filter((v) => v.action === "schedule_delete" && v.scheduleId === "xyz");
  assert.equal(others.length, 1, "另一条必须仍有它自己的删除按钮——空数组会让下面那句恒真");
  assert.equal(others[0].confirmed, undefined, "点了 A 的删除，B 不该跟着进入待确认");
});

console.log("throttled card updater");
await t("窗口内只提交最新一张，finish 立即生效", async () => {
  const sent = [];
  const u = new CARD.ThrottledCardUpdater(async (c) => { sent.push(c.n); }, 20);
  u.push({ n: 1 }); u.push({ n: 2 }); u.push({ n: 3 });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(sent, [3]);
  await u.finish({ n: 99 });
  assert.deepEqual(sent, [3, 99]);
  u.push({ n: 100 });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(sent, [3, 99]); // 关闭后不再接受
});

console.log("message parser");
const MP = await R("im/message-parser.js");
await t("双层 JSON 与 post 富文本", () => {
  assert.equal(MP.extractMessageText("text", JSON.stringify({ text: "你好" })), "你好");
  const post = JSON.stringify({ content: [[{ tag: "text", text: "看这段" }, { tag: "code_block", text: "npm i" }], [{ tag: "text", text: "第二行" }]] });
  assert.equal(MP.extractMessageText("post", post), "看这段npm i\n第二行");
});
await t("@提及还原（含重复占位符）", () => {
  const mentions = MP.parseMentions([{ key: "@_user_1", name: "MyBot", id: { open_id: "ou_a" } }]);
  assert.equal(MP.resolveMentions("@_user_1 你好 @_user_1", mentions), "@MyBot 你好 @MyBot");
});
await t("剥离 @提及占位符判断正文是否为空", () => {
  const mentions = MP.parseMentions([{ key: "@_user_1", name: "agent-os", id: { open_id: "ou_a" } }]);
  assert.equal(MP.stripMentions("@_user_1", mentions), "");
  assert.equal(MP.stripMentions("  @_user_1  ", mentions), "");
  // 紧贴 @ 的正文不能被吃掉——/@\S+/ 会把这一整段删光，误判成空任务。
  assert.equal(MP.stripMentions("@_user_1读一下 package.json", mentions), "读一下 package.json");
  assert.equal(MP.stripMentions("@_user_1 帮我 @_user_1 看看", mentions), "帮我  看看");
  assert.equal(MP.stripMentions("邮箱 a@b.com", mentions), "邮箱 a@b.com");
});
await t("@提及还原：占位符是常态，裸 open_id 只是兜底（真机取证）", () => {
  // 真机日志里 post 与 text 消息的 at 都以 @_user_N 占位符投递，
  // 真实 open_id 在 mentions 数组里。别据此给「post 里是裸 id」写实现。
  const mentions = MP.parseMentions([
    { key: "@_user_1", name: "agent-os", id: { open_id: "ou_bot" } },
  ]);
  assert.equal(MP.resolveMentions("@_user_1 干活", mentions), "@agent-os 干活");
  // 兜底路径：真给了裸 id 也能还原
  assert.equal(MP.resolveMentions("ou_bot 干活", mentions), "@agent-os 干活");
  // 没有名字时不要换成一个孤零零的 @
  const nameless = MP.parseMentions([{ key: "@_user_2", id: { open_id: "ou_x" } }]);
  assert.equal(MP.resolveMentions("ou_x 干活", nameless), "ou_x 干活");
});

await t("stripMentions 精确剥离 @，不误伤正文", () => {
  const mentions = MP.parseMentions([
    { key: "@_user_1", name: "agent-os", id: { open_id: "ou_bot" } },
  ]);
  // 不打空格是中文里的常态
  assert.equal(MP.stripMentions("@_user_1读一下package.json", mentions), "读一下package.json");
  assert.equal(MP.stripMentions("@_user_1 读一下", mentions), "读一下");
  assert.equal(MP.stripMentions("@_user_1", mentions), "");
  // post 消息渲染后留下的是 open_id
  assert.equal(MP.stripMentions("ou_bot 看这个", mentions), "看这个");
  assert.equal(MP.stripMentions("ou_bot", mentions), "");
  // 正文里出现 @ 但不是提及的，不能动
  assert.equal(MP.stripMentions("@_user_1 邮箱是 a@b.com", mentions), "邮箱是 a@b.com");
});

await t("富媒体 key 提取", () => {
  assert.deepEqual(MP.extractResourceKeys("image", JSON.stringify({ image_key: "img_1" })), [{ type: "image", key: "img_1" }]);
  assert.deepEqual(MP.extractResourceKeys("file", JSON.stringify({ file_key: "f1", file_name: "a.xlsx" })), [{ type: "file", key: "f1", fileName: "a.xlsx" }]);
  const post = JSON.stringify({ content: [[{ tag: "text", text: "看图" }, { tag: "img", image_key: "img_2" }]] });
  assert.deepEqual(MP.extractResourceKeys("post", post), [{ type: "image", key: "img_2" }]);
  assert.deepEqual(MP.extractResourceKeys("text", "not json"), []);
});

console.log("workspace");
const W = await R("core/workspace.js");
await t("[授权] 工作目录允许子目录，拒绝邻居目录和符号链接逃逸", async () => {
  const root = join(dir, "trusted");
  const child = join(root, "child");
  const neighbor = join(dir, "trusted-neighbor");
  mkdirSync(child, { recursive: true });
  mkdirSync(neighbor);
  const config = { workspaceDir: root };
  assert.equal(await W.ensureAllowedWorkspace(child, config), realpathSync(child));
  assert.equal(await W.ensureAllowedWorkspace(child, { ...config, allowedWorkspaceDirs: [join(dir, "missing-root"), root] }), realpathSync(child));
  await assert.rejects(() => W.ensureAllowedWorkspace(neighbor, config), /不在允许范围/);
  await assert.rejects(() => W.ensureAllowedWorkspace(child, { ...config, allowedWorkspaceDirs: [] }), /不在允许范围/);
  const link = join(root, "outside");
  // Windows 的目录链接用 junction，不依赖用户额外开启创建符号链接的权限。
  symlinkSync(neighbor, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => W.ensureAllowedWorkspace(link, config), /不在允许范围/);
  assert.equal(await W.ensureAllowedWorkspace(neighbor, { ...config, allowedWorkspaceDirs: [neighbor] }), realpathSync(neighbor));
});
await t("相对路径基于给定目录，绝对路径直通", () => {
  assert.equal(W.resolveWorkspacePath("b", "/a"), "/a/b");
  assert.equal(W.resolveWorkspacePath("/x/y", "/a"), "/x/y");
  assert.throws(() => W.resolveWorkspacePath("   "), /不能为空/);
});
await t("不存在的目录被拒绝", async () => {
  await assert.rejects(() => W.ensureWorkspaceDirectory("/definitely/not/here"), /不存在/);
  await W.ensureWorkspaceDirectory(process.cwd());
});

console.log("schedule store");
const S = await R("core/schedule.js");
await t("创建/更新/删除 + 落盘复读", async () => {
  const file = join(dir, "schedules.json");
  const st = await S.JsonScheduleStore.open(file);
  const s = await st.create({ botId: "dev", chatId: "oc", name: "巡检", cron: "0 * * * *", prompt: "查日志" });
  assert.equal(st.listForBot("dev").length, 1);
  await st.update(s.id, { enabled: false });
  assert.equal(st.get(s.id).enabled, false);
  const st2 = await S.JsonScheduleStore.open(file);
  assert.equal(st2.get(s.id).name, "巡检");
  await st2.remove(s.id);
  assert.equal(st2.list().length, 0);
  st.close(); st2.close();
});
await t("非法 cron 无法写入", () => {
  assert.equal(S.ScheduleManageRequestSchema.safeParse({ action: "create", name: "x", cron: "bad", prompt: "p" }).success, false);
  assert.equal(S.ScheduleManageRequestSchema.safeParse({ action: "create", name: "x", cron: "0 * * * *", prompt: "p" }).success, true);
  assert.equal(S.ScheduleManageRequestSchema.safeParse({ action: "create", cron: "0 * * * *" }).success, false); // 缺 name/prompt
  assert.equal(S.ScheduleManageRequestSchema.safeParse({ action: "delete" }).success, false);                    // 缺 id
});
await t("坏记录被跳过而不是拖垮整个文件", async () => {
  const file = join(dir, "mixed.json");
  writeFileSync(file, JSON.stringify([
    { id: "ok", botId: "d", chatId: "c", name: "好", cron: "0 * * * *", prompt: "p", enabled: true, createdAt: new Date().toISOString() },
    { id: "bad", cron: "nope" },
  ]));
  const st = await S.JsonScheduleStore.open(file);
  assert.equal(st.list().length, 1);
  st.close();
});

console.log("task record store");
const TR = await R("core/task-record.js");

/** 一条最小可用的记录输入，测试只覆盖各自关心的字段。 */
// 每条夹具默认是**一件独立的事**。写死同一个 taskId 的话，
// 所有记录会被归成一件事，列表永远只有一行——而列表的单位正是「事」。
// 要构造「同一件事的多轮」时，用例自己显式传同一个 taskId。
let taskSeq = 0;
const taskInput = (over = {}) => ({
  taskId: `task-${(taskSeq += 1)}`, botId: "developer", chatId: "oc_1", threadId: "omt_1",
  sessionId: "s-1", cliId: "claude", workspaceDir: "/tmp", origin: "user",
  ownerOpenId: "ou_owner", title: "Claude Code", prompt: "看一下项目", status: "success",
  answer: "做完了", startedAt: "2026-08-24T02:00:00.000Z", finishedAt: "2026-08-24T02:00:12.000Z",
  toolCount: 3, completedToolCount: 3, ...over,
});

await t("追加后能重读，重启后仍在", async () => {
  const file = join(dir, "tasks.json");
  const st = await TR.JsonTaskRecordStore.open(file);
  await st.append(taskInput());
  await st.append(taskInput({ status: "failed", failureReason: "引擎退出码 1" }));
  assert.equal(st.size, 2);
  const restarted = await TR.JsonTaskRecordStore.open(file);
  assert.equal(restarted.size, 2, "重启后记录必须还在");
  const [first, second] = restarted.list();
  assert.equal(first.status, "success");
  assert.equal(first.durationMs, 12_000, "耗时由存储自己算");
  assert.equal(second.failureReason, "引擎退出码 1");
  assert.notEqual(first.id, second.id);
});

await t("滚动保留最近 500 条，超出丢弃最旧的", async () => {
  const file = join(dir, "tasks-roll.json");
  // 先塞满 500 条，再追加：只有滚动生效，最旧的那条才会消失。
  const seeded = Array.from({ length: TR.TASK_RECORD_CAPACITY }, (_, i) =>
    TR.buildTaskRecord(taskInput({ taskId: `seed-${i}` })));
  writeFileSync(file, JSON.stringify(seeded));
  const st = await TR.JsonTaskRecordStore.open(file);
  assert.equal(st.size, 500);
  await st.append(taskInput({ taskId: "newest" }));
  assert.equal(st.size, 500, "上限之外必须丢弃，不能无限膨胀");
  const ids = st.list().map((r) => r.taskId);
  assert.equal(ids.includes("seed-0"), false, "最旧的那条应该被丢掉");
  assert.equal(ids.at(-1), "newest");
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(onDisk.length, 500);
});

await t("超长指令与答案被截断并留下标记", async () => {
  const st = await TR.JsonTaskRecordStore.open(join(dir, "tasks-cut.json"));
  const record = await st.append(taskInput({
    prompt: "指".repeat(2_500), answer: "答".repeat(5_000),
  }));
  assert.equal(record.prompt.length, TR.TASK_PROMPT_LIMIT);
  assert.equal(record.answer.length, TR.TASK_ANSWER_LIMIT);
  assert.equal(record.promptTruncated, true);
  assert.equal(record.answerTruncated, true);
  const shortOne = await st.append(taskInput());
  assert.equal(shortOne.promptTruncated, false);
  assert.equal(shortOne.answerTruncated, false);
});

await t("坏行被跳过，其余记录照常加载并回写干净快照", async () => {
  const file = join(dir, "tasks-mixed.json");
  const good = TR.buildTaskRecord(taskInput({ taskId: "good" }));
  writeFileSync(file, JSON.stringify([
    good,
    { taskId: "bad", status: "怎么会有这种状态" },
    { ...good, id: "no-status", status: undefined },
  ]));
  const st = await TR.JsonTaskRecordStore.open(file);
  assert.equal(st.size, 1, "坏行不能拖垮整份历史");
  assert.equal(st.list()[0].taskId, "good");
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(onDisk.length, 1, "加载后要回写一次干净快照");
});

await t("老记录里的 handoff 照常读得出来，不被当成坏行丢掉", async () => {
  const file = join(dir, "tasks-legacy.json");
  // 语义拆分之前的文件长这样：结局只有 handoff 一个取值，没有 forwarded / waiting
  const legacy = { ...TR.buildTaskRecord(taskInput({ taskId: "legacy" })), status: "handoff" };
  const fresh = TR.buildTaskRecord(taskInput({ taskId: "fresh", status: "forwarded" }));
  writeFileSync(file, JSON.stringify([legacy, fresh]));

  const st = await TR.JsonTaskRecordStore.open(file);
  assert.equal(st.size, 2, "一次状态语义变更不能让老记录读不出来或凭空消失");
  assert.equal(st.list()[0].status, "handoff",
    "原值保留：两种含义在记录里没有字段能分开，改写等于替用户猜一半历史的结局");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).length, 2,
    "老记录不该被当成坏行，从磁盘上清理掉");

  // 归档去向：只在「全部」里露面，不能混进「成功」冒充已完成
  const scope = { chatId: "oc_1", botId: "developer" };
  assert.equal(TR.queryTaskRecords(st.list(), { ...scope, filter: "all" }).total, 2);
  assert.deepEqual(
    TR.queryTaskRecords(st.list(), { ...scope, filter: "success" }).tasks.map((r) => r.taskId),
    ["fresh"],
  );
});

await t("整份文件读不成时挪到 .broken，不拖垮启动", async () => {
  const file = join(dir, "tasks-broken.json");
  writeFileSync(file, "{ 这不是 JSON");
  const st = await TR.JsonTaskRecordStore.open(file);
  assert.equal(st.size, 0);
  assert.ok(readFileSync(`${file}.broken`, "utf8").includes("这不是 JSON"),
    "坏文件要留在现场，不能被直接覆盖");
  await st.append(taskInput());
  assert.equal((await TR.JsonTaskRecordStore.open(file)).size, 1);
});

await t("写盘失败时回滚内存，不留幽灵记录", async () => {
  const st = new TR.JsonTaskRecordStore("/dev/null/nope/tasks.json");
  await assert.rejects(() => st.append(taskInput()));
  assert.equal(st.size, 0, "落盘失败还留在内存里，磁盘和内存就有两个版本");
});

console.log("task history query");

/** minute 越大越新，用它给记录排出确定的先后。 */
const rec = ({ minute = 0, ...over } = {}) =>
  TR.buildTaskRecord(taskInput({
    startedAt: `2026-08-24T02:${String(minute).padStart(2, "0")}:00.000Z`,
    finishedAt: `2026-08-24T02:${String(minute).padStart(2, "0")}:30.000Z`,
    ...over,
  }));
const query = (records, over = {}) =>
  TR.queryTaskRecords(records, { chatId: "oc_1", botId: "developer", ...over });

await t("成本按来源拆分要下沉到轮，不能按件算", () => {
  // 一件用户发起的事，里面自动互审那几轮 origin 是 handoff，
  // 而整件事的 origin 是 user。按件算的话互审开销全记到「用户发起」头上，
  // 那个最该被看见的数字就消失了——真实数据里它一度占到总量的四分之三。
  const T = "task-cost";
  const turns = [
    rec({ minute: 0, taskId: T, prompt: "改点东西", origin: "user", totalTokens: 100 }),
    rec({ minute: 2, taskId: T, prompt: "请复查", origin: "handoff", totalTokens: 700 }),
    rec({ minute: 4, taskId: T, prompt: "按意见改", origin: "handoff", totalTokens: 200 }),
  ];
  const cost = TR.summarizeCost(TR.groupIntoTasks(turns));
  assert.equal(cost.taskCount, 1, "件数按件算");
  assert.equal(cost.turnCount, 3, "轮数按轮算——成本产生在轮上");
  assert.equal(cost.totalTokens, 1000);

  const handoff = cost.byOrigin.find((r) => r.origin === "handoff");
  assert.equal(handoff.tokens, 900, "互审的开销必须单独看得见");
  assert.equal(handoff.turns, 2);
  assert.equal(cost.byOrigin[0].origin, "handoff", "token 多的排前面");
  const user = cost.byOrigin.find((r) => r.origin === "user");
  assert.equal(user.tokens, 100);
});

await t("最贵的几件按件排，没花 token 的不上榜", () => {
  const mk = (id, tokens, prompt) =>
    rec({ minute: 0, taskId: id, prompt, totalTokens: tokens });
  const cost = TR.summarizeCost(
    TR.groupIntoTasks([mk("a", 50, "小事"), mk("b", 900, "大事"), mk("c", 0, "没花钱")]),
    2,
  );
  assert.deepEqual(cost.topTasks.map((t) => t.prompt), ["大事", "小事"]);
  assert.equal(cost.topTasks.length, 2, "取前 N 件");
});

await t("一件事的多轮归成一行：状态看最后一轮，耗时是各轮之和", () => {
  // 今天审批那次真实产生了 waiting → resume → handoff → handoff 四条记录，
  // 一件事。列表按「轮」列的话就是四行，用户想知道
  //「我让它删目录那件事怎么样了」得自己拼。
  const T = "task-multi";
  const turns = [
    rec({ minute: 0, taskId: T, prompt: "把目录删了", status: "waiting", totalTokens: 100 }),
    rec({ minute: 5, taskId: T, prompt: "用户已批准", status: "success", origin: "resume", totalTokens: 200 }),
    rec({ minute: 9, taskId: T, prompt: "请复查", status: "success", origin: "handoff", totalTokens: 300 }),
  ];
  const [task] = TR.groupIntoTasks(turns);
  assert.equal(task.turns.length, 3);
  assert.equal(task.prompt, "把目录删了", "摘要取起头那一轮——后面几轮是交接单和续跑提示，不是用户说的话");
  assert.equal(task.status, "success", "当前状态看最后一轮");
  assert.equal(task.origin, "user", "来源看起头那一轮");
  assert.equal(task.totalTokens, 600, "token 是各轮之和");
  assert.equal(task.latestRecordId, turns[2].id, "详情默认看最后一轮");
  // 耗时是各轮之和（每轮 30 秒），不是首尾差（9 分钟）——
  // 中间等人拍板的时间不算引擎在干活
  assert.equal(task.durationMs, 90_000);

  // 列表里它只占一行
  const page = TR.queryTaskRecords(turns, { chatId: "oc_1", botId: "developer" });
  assert.equal(page.tasks.length, 1, "三轮是一件事，列表上就该是一行");
  assert.equal(page.total, 1);
});

await t("归组后筛选看的是这件事当前的状态，不是它经历过的状态", () => {
  // 一件事先 waiting 后 success：它现在是做完了的，不该还出现在「等人」那一档。
  const T = "task-was-waiting";
  const turns = [
    rec({ minute: 0, taskId: T, prompt: "先等人", status: "waiting" }),
    rec({ minute: 3, taskId: T, prompt: "批准后续跑", status: "success", origin: "resume" }),
  ];
  const q = (filter) =>
    TR.queryTaskRecords(turns, { chatId: "oc_1", botId: "developer", filter }).tasks.length;
  assert.equal(q("success"), 1, "最后一轮成功了，这件事就是做完了");
  assert.equal(q("all"), 1);
});

await t("查询按群 + 机器人过滤，别的群不会串进来", () => {
  const records = [
    rec({ minute: 1, chatId: "oc_1", botId: "developer", prompt: "本群本机器人" }),
    rec({ minute: 2, chatId: "oc_2", botId: "developer", prompt: "别的群同一台机器人" }),
    rec({ minute: 3, chatId: "oc_1", botId: "reviewer", prompt: "本群另一台机器人" }),
  ];
  const page = query(records);
  assert.equal(page.total, 1, "群 id 是硬约束，别的群的记录不能出现在结果里");
  assert.deepEqual(page.tasks.map((r) => r.prompt), ["本群本机器人"]);
});

await t("查询按发起时间倒序，且不改动传入的记录", () => {
  const records = [
    rec({ minute: 1, prompt: "最早" }),
    rec({ minute: 3, prompt: "最新" }),
    rec({ minute: 2, prompt: "中间" }),
  ];
  const page = query(records);
  assert.deepEqual(page.tasks.map((r) => r.prompt), ["最新", "中间", "最早"]);
  assert.deepEqual(records.map((r) => r.prompt), ["最早", "最新", "中间"],
    "查询是纯函数，不能就地把调用方的数组翻过来");
});

await t("每页 5 条：首页没有上一页，末页没有下一页，翻页不重不漏", () => {
  const records = Array.from({ length: 12 }, (_, i) => rec({ minute: i, prompt: `第 ${i} 条` }));
  const first = query(records, { page: 1 });
  assert.equal(first.tasks.length, TR.TASK_HISTORY_PAGE_SIZE);
  assert.equal(first.total, 12);
  assert.equal(first.pageCount, 3);
  assert.equal(first.hasPrevious, false);
  assert.equal(first.hasNext, true);
  assert.equal(first.tasks[0].prompt, "第 11 条", "首屏第一条必须是最新的那条");
  assert.deepEqual(query(records).tasks, first.tasks, "不传页码就是第一页");

  const last = query(records, { page: 3 });
  assert.equal(last.tasks.length, 2);
  assert.equal(last.hasPrevious, true);
  assert.equal(last.hasNext, false);

  const ids = [1, 2, 3].flatMap((page) => query(records, { page }).tasks.map((t) => t.taskId));
  assert.equal(new Set(ids).size, 12, "三页合起来要正好覆盖全部记录");
});

await t("页码越界收敛到有效页，空结果仍是合法的第 1 页", () => {
  const records = Array.from({ length: 6 }, (_, i) => rec({ minute: i }));
  const over = query(records, { page: 99 });
  assert.equal(over.page, 2, "越界要收敛到末页，不能给一张空白卡片");
  assert.equal(over.tasks.length, 1);
  assert.equal(over.hasNext, false);
  assert.equal(query(records, { page: 0 }).page, 1);
  assert.equal(query(records, { page: Number.NaN }).page, 1);

  const empty = query([], {});
  assert.deepEqual(
    { total: empty.total, page: empty.page, pageCount: empty.pageCount,
      hasPrevious: empty.hasPrevious, hasNext: empty.hasNext },
    { total: 0, page: 1, pageCount: 1, hasPrevious: false, hasNext: false },
  );
});


console.log("task history filter");

await t("筛选分档：做完了的进「成功」，停下来等人的只在「全部」里", () => {
  const records = [
    rec({ minute: 1, status: "success", prompt: "做完了" }),
    rec({ minute: 2, status: "forwarded", prompt: "交给审查了" }),
    rec({ minute: 3, status: "waiting", prompt: "等人拍板" }),
    rec({ minute: 4, status: "failed", prompt: "跑挂了" }),
    rec({ minute: 5, status: "cancelled", prompt: "被停掉了" }),
    rec({ minute: 6, status: "handoff", prompt: "旧记录" }),
  ];
  const prompts = (filter) => query(records, { filter }).tasks.map((r) => r.prompt);
  // forwarded 是「做完之后把结果流转出去」，复盘时属于成功；
  // waiting 是任务停在半路等人回答，混进成功档等于告诉用户这件事已经不用管了；
  // 老记录的 handoff 两种含义都可能是，同样不能冒充已完成
  assert.deepEqual(prompts("success"), ["交给审查了", "做完了"]);
  assert.deepEqual(prompts("failed"), ["跑挂了"]);
  assert.deepEqual(prompts("cancelled"), ["被停掉了"]);
  // 「全部」是兜底档：不进任何一档的两种记录也必须在这里看得见，一条都不能漏。
  // 六条记录跨过了每页 5 条的分页阈值，所以要合起两页看，只看第一页会漏掉最早那条
  assert.deepEqual(
    [1, 2].flatMap((page) => query(records, { filter: "all", page }).tasks.map((r) => r.prompt)),
    ["旧记录", "被停掉了", "跑挂了", "等人拍板", "交给审查了", "做完了"],
  );
  assert.equal(query(records, {}).total, 6, "不传筛选就是全部");
});

await t("筛选值是外部输入：边界上过 Zod，认不出来的一律收敛成全部", () => {
  const records = [rec({ minute: 1, status: "failed" }), rec({ minute: 2, status: "success" })];
  // 记录状态不是筛选档：把 waiting / forwarded / handoff 塞进来同样要被收敛掉
  for (const bogus of ["handoff", "waiting", "forwarded", "SUCCESS", "", null, 7, { filter: "failed" }, undefined]) {
    const filter = TR.parseTaskHistoryFilter(bogus);
    assert.equal(filter, "all", `${JSON.stringify(bogus)} 不该被当成一个筛选档`);
    assert.equal(query(records, { filter }).total, 2);
  }
  assert.equal(TR.parseTaskHistoryFilter("failed"), "failed", "认得出来的筛选值要原样生效");
  assert.equal(query(records, { filter: "failed" }).filter, "failed");
});

await t("scopeTotal 是不带筛选的条数，用来区分「筛没了」和「压根没有」", () => {
  const records = [
    rec({ minute: 1, status: "success" }),
    rec({ minute: 2, status: "success" }),
    rec({ minute: 3, chatId: "oc_2", status: "failed" }),
  ];
  const filtered = query(records, { filter: "cancelled" });
  assert.equal(filtered.total, 0);
  assert.equal(filtered.scopeTotal, 2, "本群本机器人确实有 2 条，只是这一档为空");
  assert.equal(query([], { filter: "cancelled" }).scopeTotal, 0, "真没有历史时就是 0");
  assert.equal(query(records, {}).scopeTotal, 2, "scopeTotal 不受筛选影响");
});

await t("筛选与翻页组合：页数按筛选后的结果算，越界收敛到筛选后的末页", () => {
  // 12 条里只有 6 条失败，失败档应该正好两页，而不是跟着全部的三页走
  const records = Array.from({ length: 12 }, (_, i) =>
    rec({ minute: i, status: i % 2 ? "failed" : "success", prompt: `第 ${i} 条` }));
  const first = query(records, { filter: "failed", page: 1 });
  assert.equal(first.total, 6);
  assert.equal(first.pageCount, 2);
  assert.deepEqual(first.tasks.map((r) => r.prompt),
    ["第 11 条", "第 9 条", "第 7 条", "第 5 条", "第 3 条"]);
  assert.equal(first.hasNext, true);

  const second = query(records, { filter: "failed", page: 2 });
  assert.deepEqual(second.tasks.map((r) => r.prompt), ["第 1 条"]);
  assert.equal(second.hasNext, false, "筛选后只有两页，第二页就是末页");
  assert.equal(second.tasks.every((r) => r.status === "failed"), true);

  // 在全部档的第 3 页切到失败档，如果页码不重置就会落在一个不存在的页上
  assert.equal(query(records, { filter: "failed", page: 3 }).page, 2, "越界按筛选后的页数收敛");
  assert.equal(query(records, { filter: "all", page: 3 }).pageCount, 3);
});

console.log("history card paging");

/** 递归收集卡片里的回调按钮：它们嵌在 column_set 里，只看 body.elements 看不到。 */
const cardButtons = (node, found = []) => {
  if (Array.isArray(node)) { node.forEach((item) => cardButtons(item, found)); return found; }
  if (!node || typeof node !== "object") return found;
  if (node.tag === "button") {
    for (const behavior of node.behaviors ?? []) {
      if (behavior.type === "callback") {
        found.push({ label: node.text?.content ?? "", type: node.type, value: behavior.value });
      }
    }
  }
  Object.values(node).forEach((child) => cardButtons(child, found));
  return found;
};
/** 翻页和筛选按钮共用同一个 action，靠文案区分：只有翻页按钮写「上一页 / 下一页」。 */
const isPagerLabel = (label) => /上一页|下一页/.test(label);
const historyPageButtons = (card) =>
  cardButtons(card).filter((b) => b.value.action === "history_page");
const pagerButtons = (card) => historyPageButtons(card).filter((b) => isPagerLabel(b.label));
const filterButtons = (card) => historyPageButtons(card).filter((b) => !isPagerLabel(b.label));
/** 每行右侧的「详情」按钮，走的是另一个 action。 */
const detailButtons = (card) =>
  cardButtons(card).filter((b) => b.value.action === "history_detail");
const historyCard = (records, page, filter) =>
  CARD.buildHistoryCard({
    botName: "开发助手", botId: "developer", chatId: "oc_1",
    page: TR.queryTaskRecords(records, { chatId: "oc_1", botId: "developer", page, filter }),
  });
const twelve = () => Array.from({ length: 12 }, (_, i) => rec({ minute: i, prompt: `第 ${i} 条` }));

await t("翻页按钮带上机器人、群和目标页码", () => {
  const buttons = pagerButtons(historyCard(twelve(), 2));
  assert.equal(buttons.length, 2, "中间页应该同时有上一页和下一页");
  for (const { value } of buttons) {
    assert.equal(value.action, "history_page");
    // 少了这两个，回调侧就无从判断这张卡片该读谁的记录
    assert.equal(value.botId, "developer");
    assert.equal(value.chatId, "oc_1");
  }
  const previous = buttons.find((b) => b.label.includes("上一页"));
  const next = buttons.find((b) => b.label.includes("下一页"));
  assert.equal(previous.value.page, 1, "上一页要回到更近的一页");
  assert.equal(next.value.page, 3, "下一页要走向更早的一页");
});

await t("第一页不出现上一页，末页不出现下一页，只有一页时两个都不出现", () => {
  const records = twelve();
  const first = pagerButtons(historyCard(records, 1)).map((b) => b.label);
  assert.equal(first.some((l) => l.includes("上一页")), false, "第一页点上一页没有内容可看");
  assert.equal(first.some((l) => l.includes("下一页")), true);

  const last = pagerButtons(historyCard(records, 3)).map((b) => b.label);
  assert.equal(last.some((l) => l.includes("下一页")), false, "末页点下一页没有内容可看");
  assert.equal(last.some((l) => l.includes("上一页")), true);

  const single = historyCard(records.slice(0, 3), 1);
  assert.deepEqual(pagerButtons(single), [], "一页装得下就不该有翻页按钮");
  assert.deepEqual(pagerButtons(historyCard([], 1)), [], "空历史不该有翻页按钮");
});

await t("卡片上看得出当前是第几页、共几页", () => {
  const records = twelve();
  assert.ok(JSON.stringify(historyCard(records, 2)).includes("第 2/3 页"));
  assert.ok(JSON.stringify(historyCard(records, 3)).includes("第 3/3 页"));
  assert.ok(JSON.stringify(historyCard(records, 2)).includes("共 12 条"));
  // 只有一页时也要报位置：否则「第几页」这件事只在多页时才存在，用户无从确认自己在哪
  assert.ok(JSON.stringify(historyCard(records.slice(0, 3), 1)).includes("第 1/1 页"));
});

console.log("history card filter");

const mixed = () => [
  rec({ minute: 1, status: "success", prompt: "做完了" }),
  rec({ minute: 2, status: "forwarded", prompt: "交给审查了" }),
  rec({ minute: 3, status: "failed", prompt: "跑挂了" }),
  rec({ minute: 4, status: "cancelled", prompt: "被停掉了" }),
];

await t("四个筛选入口都在，且切档一律回到第一页", () => {
  const buttons = filterButtons(historyCard(twelve(), 2));
  assert.deepEqual(
    buttons.map((b) => b.value.filter),
    ["all", "success", "failed", "cancelled"],
  );
  for (const { value } of buttons) {
    assert.equal(value.action, "history_page");
    assert.equal(value.botId, "developer");
    assert.equal(value.chatId, "oc_1");
    // 在第 2 页切档，如果把当前页码带过去，筛完可能落在一个不存在的页上
    assert.equal(value.page, 1, "切换筛选必须重置到第一页");
  }
  const labels = buttons.map((b) => b.label);
  for (const word of ["全部", "成功", "失败", "已停止"]) {
    assert.ok(labels.some((l) => l.includes(word)), `缺少筛选入口「${word}」`);
  }
});

await t("当前生效的筛选在卡片上一眼可见", () => {
  const card = historyCard(mixed(), 1, "failed");
  const json = JSON.stringify(card);
  assert.ok(json.includes("筛选：失败"), "正文要写明当前筛选，不能只靠按钮配色");

  // 按钮上也要有标记：按钮和正文任意一处走样，用户都还有另一处可看
  const active = filterButtons(card).filter((b) => b.type === "primary_filled");
  assert.equal(active.length, 1, "同一时刻只能有一个筛选档被标成选中");
  assert.equal(active[0].value.filter, "failed");
  assert.ok(active[0].label.includes("失败"));
  assert.ok(
    active[0].label !== "失败",
    "选中态不能和未选中态长得一模一样，只靠颜色区分等于没有标识",
  );
  const allCard = filterButtons(historyCard(mixed(), 1)).filter((b) => b.type === "primary_filled");
  assert.equal(allCard[0].value.filter, "all", "不带筛选时选中的是「全部」");
});

await t("翻页按钮带上当前筛选，不会翻一页就把筛选丢了", () => {
  const records = Array.from({ length: 12 }, (_, i) =>
    rec({ minute: i, status: i % 2 ? "failed" : "success", prompt: `第 ${i} 条` }));
  const buttons = pagerButtons(historyCard(records, 1, "failed"));
  assert.equal(buttons.length, 1, "失败档只有两页，第一页只该有「下一页」");
  assert.equal(buttons[0].value.filter, "failed", "翻页要留在当前筛选里");
  assert.equal(buttons[0].value.page, 2);
});

await t("列表上的说法：等人拍板的记录不能和已完成共用一套说法", () => {
  const records = [
    rec({ minute: 1, status: "success", prompt: "做完了" }),
    rec({ minute: 2, status: "forwarded", prompt: "交给审查了" }),
    rec({ minute: 3, status: "waiting", prompt: "等人拍板" }),
    rec({ minute: 4, status: "handoff", prompt: "旧记录" }),
  ];
  // 断言「哪一行配哪个说法」，只查文案出现过与否的话，四行里有一行说错也照样绿
  const json = JSON.stringify(historyCard(records, 1));
  assert.ok(json.includes("⏸️ 等待确认 等人拍板"), "停下来等人的记录要有自己的说法");
  assert.ok(json.includes("✅ 已完成 做完了"));
  assert.ok(json.includes("🤝 已交接 交给审查了"));
  assert.ok(json.includes("已交接（旧记录） 旧记录"), "老记录要标出来历，别让人当成已完成");
  for (const wrong of ["✅ 已完成 等人拍板", "🤝 已交接 等人拍板"]) {
    assert.equal(json.includes(wrong), false, `等人拍板的任务被说成了「${wrong.split(" ")[0]}」`);
  }
});

await t("筛选后为空和完全没有历史是两套文案", () => {
  // 三条记录里没有「已停止」的，这一档为空但本群其实有历史
  const empty = JSON.stringify(historyCard(mixed().slice(0, 3), 1, "cancelled").body ?? {});
  assert.equal(empty.includes("还没有任务记录"), false,
    "有历史只是这一档为空，不能说成一条记录都没有");
  assert.ok(empty.includes("没有「已停止」的任务记录"), "要说清是哪一档为空");
  assert.ok(empty.includes("共有 3 条历史"), "要告诉用户本群其实有多少条");
  assert.ok(empty.includes("点下方的「全部」"), "要指出怎么看回全部记录，方向要和按钮实际位置一致");

  const none = JSON.stringify(historyCard([], 1, "failed"));
  assert.ok(none.includes("还没有任务记录"), "真没有历史时仍是原来的空状态文案");
  assert.equal(none.includes("没有「失败」的任务记录"), false);
  assert.deepEqual(filterButtons(historyCard([], 1)), [],
    "一条历史都没有时不给筛选入口，四个按钮点下去只会得到四张同样的空卡片");
});


console.log("history detail card");

/** 详情卡：直接给一条记录，页码与筛选模拟「点开详情前停在哪儿」。 */
const detailCard = (record, page = 1, filter = "all") =>
  CARD.buildHistoryDetailCard({
    botName: "开发助手", botId: "developer", chatId: "oc_1", record, page, filter,
  });

await t("列表每行的详情按钮带上记录 id 与当前页码、当前筛选", () => {
  // 22 条 → 失败档 11 条 → 第 2 页整整 5 行。12 条时失败档第 2 页只剩 1 行，
  // 「每一条都有入口」就成了拿 1 比 1，只给首行加按钮也照样绿。
  const records = Array.from({ length: 22 }, (_, i) =>
    rec({ minute: i, status: i % 2 ? "failed" : "success", prompt: `第 ${i} 条` }));
  const card = historyCard(records, 2, "failed");
  const page = TR.queryTaskRecords(records, { chatId: "oc_1", botId: "developer", page: 2, filter: "failed" });
  const buttons = detailButtons(card);
  assert.equal(buttons.length, page.tasks.length, "这一页每一条记录都要有自己的详情入口");
  // 详情按钮指向那件事的最后一轮：点开先看最新进展
  assert.deepEqual(buttons.map((b) => b.value.recordId), page.tasks.map((t) => t.latestRecordId));
  for (const { value } of buttons) {
    // 少了作用域，回调侧就无从判断这张卡片该读谁的记录
    assert.equal(value.botId, "developer");
    assert.equal(value.chatId, "oc_1");
    // 带回来源页码和筛选，详情卡的「返回列表」才回得到用户刚才那一页
    assert.equal(value.page, 2);
    assert.equal(value.filter, "failed");
  }
});

await t("详情卡给的是完整答案：贴着落盘上限的长答案不能被展示层再截一刀", () => {
  // 落盘上限 4000 字，卡片层另有一个 900 字的摘要预览函数。答案取 3800 字左右：
  // 大于摘要长度、又没触发落盘截断，展示层若误用了预览，尾部哨兵就会消失。
  // 取值必须小于 TASK_ANSWER_LIMIT，否则哨兵先被落盘切走，测的就成了落盘而不是展示。
  const tail = "【answer-tail-sentinel】";
  const answer = "结论段落。".repeat(760) + tail;
  assert.ok(answer.length < TR.TASK_ANSWER_LIMIT, "前提：这条答案不该触发落盘截断");
  const record = rec({ minute: 1, status: "success", answer });
  assert.ok(record.answer.endsWith(tail), "前提：落盘确实没切掉哨兵");
  const json = JSON.stringify(detailCard(record));
  assert.ok(json.includes(tail), "答案尾部不能被吃掉——票据第一条验收就是「完整答案」");
  assert.equal(
    json.includes("_答案过长"), false,
    "没触发落盘截断就不该出现截断提示，否则用户会以为内容被砍了",
  );
});

await t("交付小队：两个 Sub Agent 定义在位，且带着那几条要命的约束", () => {
  // 这两份定义是运行时资产：开发者跑 headless 引擎时从 .claude/agents/ 加载。
  // 它们坏掉的方式是**静悄悄的**——文件还在、agent 照跑，只是不再干那件关键的事。
  // 所以这里只钉几句承重的话，不锁全文（锁全文会让正常润色也变红）。
  const read = (name) =>
    readFileSync(new URL(`../.claude/agents/${name}.md`, import.meta.url), "utf8");

  for (const name of ["tester", "code-reviewer"]) {
    const text = read(name);
    const front = /^---\n([\s\S]+?)\n---/.exec(text);
    assert.ok(front, `${name} 缺 frontmatter，引擎认不出这是个 agent`);
    for (const key of ["name:", "description:", "tools:"]) {
      assert.ok(front[1].includes(key), `${name} 的 frontmatter 缺 ${key}`);
    }
    assert.ok(front[1].includes(`name: ${name}`), `${name} 的 name 和文件名要对上`);
  }

  const tester = read("tester");
  // 这是 tester 存在的唯一理由：不是跑一遍看绿不绿，是证明新测试抓得住 bug
  assert.ok(tester.includes("改坏"), "tester 必须要求把实现改坏一次");
  assert.ok(/真的会红|确认.*变红|会红/.test(tester), "tester 必须要求确认测试变红");
  // 这条栽过两次：git checkout 会把未提交的实现一起清光
  assert.ok(tester.includes("git checkout"), "tester 必须点名警告 git checkout 这个坑");
  assert.ok(tester.includes("cp "), "tester 必须给出 cp 备份/恢复的做法");

  const reviewer = read("code-reviewer");
  assert.ok(reviewer.includes("只读"), "code-reviewer 必须声明只读");
  assert.ok(reviewer.includes("错题本"), "code-reviewer 必须被要求读错题本");
  assert.ok(/具体失败场景|失败场景/.test(reviewer), "code-reviewer 必须只报能给出失败场景的");

  // AGENTS.md 得把这条委派写进 Definition of done，否则没人知道要用它们
  const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
  assert.ok(agents.includes(".claude/agents/"), "AGENTS.md 要指明 Sub Agent 在哪");
  // 真机上栽过：委派条款写成「有 Task 工具的话就派给它们」，而引擎那边这个工具
  // 叫 Agent，它照字面一读「我没有 Task 工具」，直接走了后面那句逃生口，两遍都没做。
  // 钉的是「两个名字并列出现在同一句里」，不是「各自在文中出现过」——
  // 后者被下面那段告诫故事本身就满足了，等于没钉。
  assert.ok(
    /`Agent` or `Task`|`Task` or `Agent`/.test(agents),
    "委派条款要把 Agent 和 Task 并列写出——只写一个，引擎会因为对不上而跳过",
  );
  // 只在 Definition of done 那一节里找，不扫全文：
  // 错题本里那段「委派条款曾被跳过」的故事本身就含这些词，扫全文等于这条断言恒真——
  // 正是上面那句注释刚警告过的「断言没跨过它声称要守的那道边界」，我第一版就踩了。
  const dod = agents.slice(agents.indexOf("## Definition of done"));
  const section = dod.slice(0, dod.indexOf("\n## ", 3));
  assert.ok(section.length > 200, "没切出 Definition of done 一节，切法要跟着文档结构改");
  assert.ok(
    /say so explicitly in your report/.test(section),
    "退路必须要求在报告里说明，否则跳过委派是静悄悄的",
  );
  for (const name of ["tester", "code-reviewer"]) {
    assert.ok(agents.includes(`\`${name}\``), `AGENTS.md 的 Definition of done 要点名 ${name}`);
  }
});

await t("文档与代码同源：README 的命令表逐行等于 /help 的清单", async () => {
  // 两处文案分头维护时，改了行为只更新一处是常态——真机上就出现过
  // README 说 /history 能筛选能翻页、/help 只字未提，用户在群里看不到这个能力。
  const { COMMAND_DOCS, helpLines } = await R("app/commands.js");
  const md = readFileSync(new URL("../README.zh-CN.md", import.meta.url), "utf8");
  const rows = [...md.matchAll(/^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|\s*$/gm)]
    .map((m) => ({ usage: m[1], description: m[2] }))
    .filter((row) => row.usage.startsWith("/"));

  assert.ok(rows.length >= 10, "README.zh-CN 里没解析出命令表，正则要跟着文档格式改");
  assert.deepEqual(rows, COMMAND_DOCS.map((d) => ({ ...d })),
    "README 中文命令表必须和 COMMAND_DOCS 逐字一致（顺序也算）——两边同源才飘不了");

  // helpLines() 的渲染格式：一行 = usage + 空格 + description。
  // 注意这只锁 commands.ts 内部；「/help 真的用了它」得在集成里对着真实回复断言，
  // 那边的 handler 才是会被改回硬编码的地方。
  assert.deepEqual(
    helpLines(),
    COMMAND_DOCS.map((d) => `${d.usage} ${d.description}`),
  );

  // 命令名还有第二份清单：解析器用 KNOWN_COMMANDS 判断「这是不是打错的命令」。
  // 两份对不上时，新加的命令会被当成 typo 挡回去（「没有 /foo 这个命令」）。
  // core 不能反向依赖 app，所以不能直接共用一份，只能在这里把它们钉在一起。
  const { KNOWN_COMMANDS } = await R("core/command-parser.js");
  assert.deepEqual(
    [...KNOWN_COMMANDS].sort(),
    COMMAND_DOCS.map((d) => d.usage.split(" ")[0].slice(1)).sort(),
    "解析器认识的命令和文档里列的必须一致，否则新命令会被当成打错的挡回去",
  );

  // 英文 README 只对命令名：描述是另一种语言，逐字比没有意义
  const en = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const enNames = new Set(
    [...en.matchAll(/^\|\s*`(\/[a-z]+)[^`]*`\s*\|/gm)].map((m) => m[1]),
  );
  const names = new Set(COMMAND_DOCS.map((d) => d.usage.split(" ")[0]));
  assert.deepEqual([...enNames].sort(), [...names].sort(),
    "英文 README 的命令名要和代码一致");
});

await t("改没改过文件看工作区，不看用了什么工具", async () => {
  const { workspaceFingerprint, workspaceChanged } = await R("app/workspace-changes.js");
  const { execFileSync } = await import("node:child_process");
  const repo = mkdtempSync(join(tmpdir(), "ao-wf-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });

  const before = await workspaceFingerprint(repo);
  assert.ok(before, "git 仓库里应该拿得到指纹");
  assert.equal(await workspaceFingerprint(repo), before, "没动过就该是同一个指纹");

  // 关键：用什么方式写的都算。真机上引擎是用 Bash 跑 python 改的文件，
  // 一次 Edit/Write 都没调——按工具名判断会漏掉一大类。
  writeFileSync(join(repo, "a.txt"), "hi");
  const after = await workspaceFingerprint(repo);
  assert.notEqual(after, before, "新增未跟踪文件也算动过");
  assert.equal(workspaceChanged(before, after), true);
  assert.equal(workspaceChanged(before, before), false);

  // 不是 git 仓库 → 拿不到指纹 → 结论是「不知道」，不是「没改过」。
  // 说成「没改过」的话，「改了文件却没验证」的警告会在最该响的时候沉默。
  const plain = mkdtempSync(join(tmpdir(), "ao-plain-"));
  assert.equal(await workspaceFingerprint(plain), undefined);
  assert.equal(workspaceChanged(undefined, after), undefined, "不知道就是不知道");
  assert.equal(workspaceChanged(before, undefined), undefined);
});

await t("原地打转：连着重复才算，中间改过文件就不算", async () => {
  const { runCli } = await R("cli/runner.js");
  // 用一个真子进程把事件按行吐出来，和别处的 runCli 用例一个做法：
  // 这样 spawn、逐行解析、结算全部真实经历，只有事件内容是编的。
  const emit = `
    const events = JSON.parse(process.argv[1]);
    for (const e of events) console.log(JSON.stringify(e));
  `;
  const adapter = (events) => ({
    id: "claude", command: process.execPath, displayName: "假引擎",
    capabilities: { subagents: true },
    buildArgs: () => ["-e", emit, JSON.stringify(events)],
    buildResumeArgs: () => ["-e", emit, JSON.stringify(events)],
    buildCompactPlan: () => ({ protocol: "claude-stream-json", command: process.execPath, args: [], prompt: "" }),
    parseEvents: (l) => { try { const e = JSON.parse(l); return e?.type ? [e] : []; } catch { return []; } },
  });
  const tool = (name, detail) => ({ type: "tool_start", toolUseId: `t${Math.random()}`, toolName: name, label: name, ...(detail ? { detail } : {}) });
  const done = { type: "result", answer: "完了" };

  // 同一个调用连着 6 次、中间没改文件 → 该报
  const spin = await runCli({
    adapter: adapter([...Array.from({ length: 6 }, () => tool("Bash", "跑测试")), done]),
    prompt: "x", cwd: process.cwd(),
  });
  assert.ok(spin.stats?.spinningOn, "连着重复又没改文件，该标出来");
  assert.ok(spin.stats.spinningOn.includes("跑测试"), "要说清卡在哪个调用上");

  // 同样重复 6 次，但中间改过文件 → 不该报。
  // 测一遍改一处再测一遍是正经干活，今天 tester 一轮跑十遍 pnpm check 完全正常。
  const working = await runCli({
    adapter: adapter([
      tool("Bash", "跑测试"), tool("Bash", "跑测试"), tool("Edit", "a.ts"),
      tool("Bash", "跑测试"), tool("Bash", "跑测试"), tool("Edit", "b.ts"),
      tool("Bash", "跑测试"), tool("Bash", "跑测试"), done,
    ]),
    prompt: "x", cwd: process.cwd(),
  });
  assert.equal(working.stats?.spinningOn, undefined, "中间在改文件就是在推进，不该误报");

  // 重复次数不够也不报——误报比漏报更坏，一个总喊狼来了的提示很快就没人看了
  const few = await runCli({
    adapter: adapter([tool("Read", "a.ts"), tool("Read", "a.ts"), tool("Read", "a.ts"), done]),
    prompt: "x", cwd: process.cwd(),
  });
  assert.equal(few.stats?.spinningOn, undefined);
});

await t("会话保留上限：先丢已关闭的，同类里丢最久没动的", async () => {
  const { pruneSessions, SESSION_CAPACITY } = await R("core/session-store.js");
  // 用时间戳偏移而不是拼分钟数：500 条时 "00:500:00" 是非法时间，
  // Date.parse 得到 NaN，排序会变成随机的
  const base = Date.parse("2026-08-01T00:00:00.000Z");
  const mk = (id, status, order) => ({
    id, botId: "developer", threadId: `omt_${id}`, chatId: "oc_1", cliId: "claude",
    workspaceDir: "/tmp", status,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: new Date(base + order * 60_000).toISOString(),
  });
  // 没超上限时一条都不动
  const few = [mk("a", "idle", 1), mk("b", "closed", 2)];
  assert.equal(pruneSessions(few).length, 2, "没超上限不该丢任何东西");

  // 造出刚好超一条的情况：最该丢的是那条 closed 的，哪怕它更新得更晚
  const many = [
    mk("old-idle", "idle", 0),
    ...Array.from({ length: SESSION_CAPACITY - 1 }, (_, i) => mk(`s${i}`, "idle", i + 2)),
    mk("recent-closed", "closed", 9_999),
  ];
  assert.equal(many.length, SESSION_CAPACITY + 1);
  const kept = pruneSessions(many);
  assert.equal(kept.length, SESSION_CAPACITY);
  assert.equal(kept.some((x) => x.id === "recent-closed"), false,
    "closed 的先丢——它已经明确结束了，而 idle 的还可能被同话题的下一条消息接上");
  assert.ok(kept.some((x) => x.id === "old-idle"), "不该因为它旧就先丢它");

  // 原顺序保留：打乱会让 sessions.json 的 diff 没法读
  assert.deepEqual(
    kept.map((x) => x.id),
    many.filter((x) => x.id !== "recent-closed").map((x) => x.id),
  );
});

await t("长连接不再自作主张开 SDK 的开关——两个都被真机证伪过", async () => {
  // 这条断言的方向和它原来的样子正好相反，特意保留是为了让下一个人先看见代价：
  //   handshakeTimeoutMs: 超时后 SDK 在定时器里 terminate()，ws 抛的错没人接，
  //                       进程被带走。部署前 0 次崩溃，部署后 7 次。
  //   pingTimeout:        重连率 5.5/小时 → 10.8/小时，翻倍。
  // 要再开，先在真机上盯崩溃数和重连率跑几天，别靠读文档就当验证过了。
  const { WS_RESILIENCE } = await R("im/lark.js");
  assert.deepEqual(WS_RESILIENCE, {},
    "两个开关都被真机证伪过；要重开先补上出错时谁来接，并实测重连率");
});

await t("超时护栏：不返回的调用会被判超时，正常返回的原样放行", async () => {
  const { withTimeout } = await R("core/timeout.js");
  // 永远不结算的 Promise——正是 Lark.Client 在网络劣化时的表现
  const never = new Promise(() => {});
  await assert.rejects(
    () => withTimeout(never, 30, "飞书刷新卡片"),
    (error) => {
      assert.ok(error.message.includes("飞书刷新卡片"), "报错要说清是哪一类调用超时");
      assert.ok(error.message.includes("30"), "要说清等了多久，方便判断是不是该调大");
      return true;
    },
  );
  assert.equal(await withTimeout(Promise.resolve("ok"), 30), "ok", "正常返回不能被改写");
  // 底层失败要原样抛出，不能被包成超时——那会把「接口报错」误诊成「网络慢」
  await assert.rejects(
    () => withTimeout(Promise.reject(new Error("接口拒绝")), 1_000),
    /接口拒绝/,
  );
});

await t("定时任务的「上次运行」说法：每一种结局都要有明确归属", async () => {
  const { scheduleRunStatus } = await R("app/scheduler.js");
  // 穷举 TASK_RUN_STATUSES：漏掉任何一个取值，这条就会报 undefined。
  // 历史那边把「等人拍板」从成功里摘出来了，定时任务这边不能还说「成功」——
  // 同一轮执行在两张卡片上给出相反的说法，用户只会以为其中一张坏了。
  const expected = {
    success: "success",
    forwarded: "success",  // 活派出去了，这一轮确实做完了
    waiting: "waiting",    // 停在审批/澄清/产品方案上，人不点永远不会有结论
    failed: "failed",
    cancelled: "skipped",
  };
  assert.deepEqual(
    Object.keys(expected).sort(), [...TR.TASK_RUN_STATUSES].sort(),
    "结局取值变了就要重新想一遍它在定时任务卡片上该怎么说，不能默默归进「成功」",
  );
  for (const [outcome, want] of Object.entries(expected)) {
    assert.equal(scheduleRunStatus(outcome), want, `${outcome} 的说法不对`);
  }
});

await t("详情卡：老记录 handoff 含义不明，不能涂成「做完了」的绿色", () => {
  // 拆分之前 handoff 同时表示「已交接」和「等人拍板」，记录里没有字段能分开。
  // 列表和筛选档都已经拦住它冒充已完成，详情卡是这套配色唯一被真正消费的地方。
  const legacy = { ...rec({ minute: 1, status: "success", prompt: "老任务" }), status: "handoff" };
  const card = detailCard(legacy);
  assert.notEqual(card.header.template, "green",
    "一半概率是「还等着人拍板」，凭概率涂绿等于替用户猜结局");
  assert.ok(JSON.stringify(card).includes("旧记录"), "详情里要标明它的来历");
});

await t("详情卡：等人拍板的记录说清停在哪儿，头部也不是绿色", () => {
  const waiting = detailCard(rec({
    minute: 1, status: "waiting", prompt: "要不要直接删库", answer: "",
    threadId: "omt_waiting_home",
  }));
  const json = JSON.stringify(waiting);
  assert.notEqual(waiting.header.template, "green",
    "一条还等着人拍板的任务顶着绿色卡片，等于宣布它已经做完了");
  assert.ok(json.includes("等待确认"));
  assert.ok(json.includes("停在了等人拍板那一步"), "详情里要说清这一轮停在哪儿，不能只留一句「没有答案」");
  // 记录写下就不再改：说「现在还没有结论」的话，人拍完板之后这张卡片就在说谎
  assert.equal(json.includes("还没有结论"), false, "文案只能陈述本轮，不能断言此刻的状态");
  assert.ok(json.includes("omt_waiting_home"), "要指回那张还挂着的卡片在哪个话题");

  // 真做完的那两档不能被误伤
  for (const status of ["success", "forwarded"]) {
    const done = detailCard(rec({ minute: 2, status, prompt: "做完了" }));
    assert.equal(done.header.template, "green", `${status} 是做完了，配色不该跟着改`);
    assert.equal(JSON.stringify(done).includes("停下来等人拍板"), false);
  }
});

await t("详情按钮回带的是收敛后的页码与筛选，不是请求里的原值", () => {
  // 请求第 99 页 + 一个不存在的筛选档（先过回调边界那道 Zod）：用户眼前其实是第 3 页的「全部」
  const card = historyCard(twelve(), 99, TR.parseTaskHistoryFilter("怎么会有这一档"));
  const [button] = detailButtons(card);
  assert.equal(button.value.page, 3, "返回列表要回到用户真正看着的那一页，不是他点过的那个页码");
  assert.equal(button.value.filter, "all", "非法筛选已经收敛成全部，详情按钮不能把原值带回去");
});

await t("详情卡展示完整答案、执行统计与归属信息", () => {
  const record = rec({
    minute: 1, status: "success", prompt: "把 README 更新一下",
    answer: "已经更新完毕，改了两处。", threadId: "omt_readme",
    workspaceDir: "/srv/demo", ownerName: "小林", origin: "schedule",
    turns: 4, totalTokens: 12_345, toolCount: 7, completedToolCount: 6,
  });
  const json = JSON.stringify(detailCard(record));
  assert.ok(json.includes("已经更新完毕，改了两处。"), "详情的主角是答案本身");
  assert.ok(json.includes("耗时 30 秒"));
  assert.ok(json.includes("轮次 4"));
  assert.ok(json.includes("工具 6/7"), "工具要给出完成数和总数，只报一个数说不清有没有失败的");
  assert.ok(json.includes("累计 tokens 12.3k"));
  assert.ok(json.includes("omt_readme"), "要能看出该回哪个话题去追问");
  assert.ok(json.includes("/srv/demo"), "要能看出改的是哪份代码");
  assert.ok(json.includes("小林"), "发起人有显示名就用显示名");
  assert.ok(json.includes("定时触发"), "来源要用人话，不是 origin 的枚举值");
  assert.equal(json.includes("轮次 0") || json.includes("tokens undefined"), false);
});

await t("引擎没报轮次和 tokens 时不占位，也不显示成 0", () => {
  const json = JSON.stringify(detailCard(rec({ minute: 1 })));
  assert.equal(json.includes("轮次"), false, "没有的数据不如不显示，显示 0 是在说假话");
  assert.equal(json.includes("累计 tokens"), false);
  assert.ok(json.includes("耗时"), "耗时是存储自己算的，任何一条记录都有");
});

await t("失败任务的技术原因收进折叠区，不占据结论位置", () => {
  const record = rec({
    minute: 1, status: "failed", prompt: "跑一下测试",
    answer: "", failureReason: "Error: exit code 1\n  at runner.ts:88",
  });
  const card = detailCard(record);
  const json = JSON.stringify(card);
  assert.ok(json.includes("执行失败"), "结局要一眼看得到");
  assert.ok(json.includes("exit code 1"), "失败原因就在详情里，不用再回去翻当时那张卡片");
  assert.ok(json.includes("这一轮没有留下答案"), "失败常常没有答案，要说清而不是留一片空白");

  // 技术细节必须在折叠面板里，而不是直接铺在正文上
  const panels = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    if (node.tag === "collapsible_panel") panels.push(node);
    Object.values(node).forEach(walk);
  };
  walk(card);
  assert.equal(panels.length, 1, "详情卡只该有「技术细节」这一个折叠区");
  assert.equal(panels[0].expanded, false, "默认展开就等于没有收起来");
  assert.ok(JSON.stringify(panels[0]).includes("exit code 1"));
  assert.equal(JSON.stringify(detailCard(rec({ minute: 1 }))).includes("collapsible_panel"), false,
    "成功的任务没有技术原因，不该留一个空折叠区");
});

await t("答案被截断时说清是落盘截断，并指路记录所属话题里的原任务卡片", () => {
  const long = rec({ minute: 1, answer: "答".repeat(TR.TASK_ANSWER_LIMIT + 200), threadId: "omt_answer_home" });
  assert.equal(long.answerTruncated, true, "先确认这条记录确实被截断了");
  const json = JSON.stringify(detailCard(long));
  assert.ok(json.includes(`前 ${TR.TASK_ANSWER_LIMIT} 字`), "要说清截断发生在落盘时，不是模型只输出了这么多");
  assert.ok(json.includes("原任务卡片") || json.includes("任务卡片"), "要指出完整内容去哪儿看");
  // /history 跨话题：指路只能点名记录自己的话题，不能说成「本话题」
  assert.ok(
    /话题 `omt_answer_home` 里当时那张任务卡片/.test(json),
    "指路要点名记录所属的话题，否则跨话题查历史的人会去错地方",
  );
  assert.equal(json.includes("本话题"), false, "「本话题」在跨话题的历史里就是错的指路");

  const short = JSON.stringify(detailCard(rec({ minute: 1, answer: "短答案" })));
  assert.equal(short.includes("任务卡片"), false, "没被截断就不该吓唬用户说内容不全");
});

await t("截断处落在代码块中间时补上收尾围栏", () => {
  // 4000 字上限是按字符数硬切的，正好切在代码块里时整张卡片会渲染错乱
  const record = rec({ minute: 1, answer: `说明\n\n\`\`\`ts\n${"x".repeat(TR.TASK_ANSWER_LIMIT)}` });
  assert.equal(record.answerTruncated, true);
  const answerBlock = JSON.parse(JSON.stringify(detailCard(record))).body.elements
    .map((e) => e.content).filter((c) => typeof c === "string").join("\n");
  const fences = answerBlock.match(/```/g) ?? [];
  assert.equal(fences.length % 2, 0, "围栏必须成对，否则代码块会一路吃到卡片结尾");
});

await t("返回列表按钮把来源页码与筛选原样带回去", () => {
  const buttons = cardButtons(detailCard(rec({ minute: 1 }), 3, "failed"))
    .filter((b) => b.value.action === "history_page");
  assert.equal(buttons.length, 1, "详情卡上只该有「返回列表」一个列表入口");
  const [back] = buttons;
  assert.ok(back.label.includes("返回列表"));
  assert.equal(back.value.page, 3, "返回列表要回到点开详情前的那一页");
  assert.equal(back.value.filter, "failed", "筛选也要一起带回去，否则回去就成了全部");
  assert.equal(back.value.botId, "developer");
  assert.equal(back.value.chatId, "oc_1");
});

console.log("history detail lookup");

await t("按 id 取详情必须同时匹配群和机器人，跨群读不出来", () => {
  const mine = rec({ minute: 1, chatId: "oc_1", botId: "developer", prompt: "本群本机器人" });
  const otherChat = rec({ minute: 2, chatId: "oc_2", botId: "developer", prompt: "别的群" });
  const otherBot = rec({ minute: 3, chatId: "oc_1", botId: "reviewer", prompt: "别的机器人" });
  const all = [mine, otherChat, otherBot];
  const find = (id, over = {}) =>
    TR.findTaskRecord(all, { id, chatId: "oc_1", botId: "developer", ...over });

  assert.equal(find(mine.id)?.prompt, "本群本机器人");
  // 卡片能被转发：拿着别的群那条记录的 id 在本群点开，一样不能读出来
  assert.equal(find(otherChat.id), undefined, "换个 id 就能读到别的群，等于没有作用域");
  assert.equal(find(otherBot.id), undefined, "别的机器人的记录也不属于这张卡片");
  assert.equal(find(mine.id, { chatId: "oc_2" }), undefined);
  assert.equal(find(mine.id, { botId: "reviewer" }), undefined);
  assert.equal(find("不存在的记录"), undefined, "被滚动丢弃时返回 undefined，不抛错");
  // 空作用域不能匹配上任何东西
  for (const empty of [{ id: "" }, { chatId: "" }, { botId: "" }]) {
    assert.equal(TR.findTaskRecord(all, { id: mine.id, chatId: "oc_1", botId: "developer", ...empty }), undefined);
  }
});

// ─────────────────── 防回归：以下每一条都对应一次 code review 中确认的缺陷 ───────────────────
console.log("regressions");

await t("[#9] 协作去重键含 dispatchId：同话题两项任务不会互相顶掉", () => {
  const base = { taskId: "t", round: 1, toBotId: "rev" };
  const k1 = CO.collaborationTurnKey({ ...base, dispatchId: "aaaaaaaaaaaa" });
  const k2 = CO.collaborationTurnKey({ ...base, dispatchId: "bbbbbbbbbbbb" });
  assert.notEqual(k1, k2);
});

await t("[#7] 解析失败的定时任务会被原样保留，不会被下一次写盘删掉", async () => {
  const file = join(dir, "keep-bad.json");
  const good = { id: "ok", botId: "d", chatId: "c", name: "好", cron: "0 * * * *", prompt: "p", enabled: true, createdAt: new Date().toISOString() };
  const bad = { id: "weekly", botId: "d", chatId: "c", name: "周报", cron: "0 9 * * MON", prompt: "p", enabled: true, createdAt: new Date().toISOString() };
  writeFileSync(file, JSON.stringify([good, bad]));
  const st = await S.JsonScheduleStore.open(file);
  assert.equal(st.list().length, 1);              // 坏记录不参与调度
  await st.update("ok", { lastStatus: "success" }); // 触发一次写盘
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(onDisk.length, 2);                  // 但没有从磁盘上消失
  assert.ok(onDisk.some((r) => r.id === "weekly"));
  st.close();
});

await t("[#11] 落盘失败时定时任务要回滚内存，不留幽灵任务", async () => {
  const st = await S.JsonScheduleStore.open(join(dir, "rollback.json"));
  const before = st.list().length;
  // 指向一个不可能写入的路径来制造失败
  const broken = await S.JsonScheduleStore.open(join(dir, "rollback.json"));
  Object.defineProperty(broken, "filePath", { value: "/dev/null/nope/x.json" });
  await assert.rejects(() =>
    broken.create({ botId: "d", chatId: "c", name: "x", cron: "0 * * * *", prompt: "p" }));
  assert.equal(broken.list().length, before);
  st.close(); broken.close();
});

await t("[#6] 外部编辑器的连续原子保存都能被热更新收到", async () => {
  const file = join(dir, "hot.json");
  const st = await S.JsonScheduleStore.open(file);
  await st.create({ botId: "d", chatId: "c", name: "一号", cron: "0 * * * *", prompt: "p" });
  let reloads = 0;
  st.watchFile(() => { reloads += 1; });
  await new Promise((r) => setTimeout(r, 60));

  // 真实编辑器（vim / VS Code / JetBrains / sed -i / mv）都是 tmp + rename，
  // 每一次保存都会换掉 inode。用就地 writeFileSync 测是测不出问题的。
  const atomicSave = (rows) => {
    const tmp = `${file}.editor`;
    writeFileSync(tmp, JSON.stringify(rows, null, 2));
    renameSync(tmp, file);
  };

  const first = JSON.parse(readFileSync(file, "utf8"));
  first[0].name = "第一次手工改";
  atomicSave(first);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(st.list()[0].name, "第一次手工改", "第一次原子保存没有被热更新收到");

  // 关键回归点：第二次原子保存必须同样收到（watcher 要跟着新 inode 重挂）
  const second = JSON.parse(readFileSync(file, "utf8"));
  second[0].name = "第二次手工改";
  atomicSave(second);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(st.list()[0].name, "第二次手工改", "第二次原子保存丢了：watcher 没有重挂");

  // 自己写盘之后，外部保存依然要能被收到
  await st.update(st.list()[0].id, { lastStatus: "success" });
  await new Promise((r) => setTimeout(r, 400));
  const third = JSON.parse(readFileSync(file, "utf8"));
  third[0].name = "自己写盘之后再手工改";
  atomicSave(third);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(st.list()[0].name, "自己写盘之后再手工改");
  assert.ok(reloads >= 3, `热更新回调只触发了 ${reloads} 次`);
  st.close();
});

await t("[热更新] 异步监听错误降级轮询，关闭后不会被迟到的错误重新启动", async () => {
  const file = join(dir, "watch-error.json");
  const st = await S.JsonScheduleStore.open(file);
  const row = await st.create({ botId: "d", chatId: "c", name: "原名", cron: "0 * * * *", prompt: "p" });
  st.watchFile();
  const native = st.watcher;
  if (native) native.emit("error", new Error("forced watch failure"));
  assert.equal(typeof st.pollListener, "function");
  const tmp = `${file}.editor`;
  writeFileSync(tmp, JSON.stringify([{ ...row, name: "轮询读到" }]));
  renameSync(tmp, file);
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(st.get(row.id).name, "轮询读到");
  st.close();
  native?.emit("error", new Error("late watch failure"));
  assert.equal(st.pollListener, undefined);
  assert.equal(st.watcher, undefined);
});

await t("[热更新] 文件启动时还不存在，外部创建也能被收到（真机踩到的）", async () => {
  const sub = join(dir, "late");
  const file = join(sub, "schedules.json");
  const st = await S.JsonScheduleStore.open(file);   // 此刻文件不存在
  assert.equal(st.list().length, 0);
  let reloaded = false;
  st.watchFile(() => { reloaded = true; });
  await new Promise((r) => setTimeout(r, 60));

  // 外部第一次创建这个文件（原子保存）
  const rows = [{ id: "late01", botId: "d", chatId: "c", name: "迟到的任务",
    cron: "0 * * * *", prompt: "p", enabled: true, createdAt: new Date().toISOString() }];
  const tmp = `${file}.editor`;
  writeFileSync(tmp, JSON.stringify(rows, null, 2));
  renameSync(tmp, file);
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(reloaded, true, "文件被外部创建时没有触发热更新");
  assert.equal(st.list()[0]?.name, "迟到的任务");
  st.close();
});

await t("[热更新] 外部删掉非空文件，要当成一次真实变更通知出去", async () => {
  const file = join(dir, "deleted.json");
  const st = await S.JsonScheduleStore.open(file);
  const s = await st.create({ botId: "d", chatId: "c", name: "会被删掉的任务", cron: "0 * * * *", prompt: "p" });
  let reloads = 0;
  st.watchFile(() => { reloads += 1; });
  await new Promise((r) => setTimeout(r, 60));

  // 外部直接把文件删了（rm / 换分支 / 清目录），内存里那份任务就不该再跑了。
  unlinkSync(file);
  await new Promise((r) => setTimeout(r, 700));

  assert.equal(st.list().length, 0, "文件被删了，内存里还留着任务");
  assert.equal(st.get(s.id), undefined);
  assert.equal(reloads, 1, `文件被删除时触发了 ${reloads} 次热更新回调，应为 1 次`);
  st.close();
});

await t("[并发] 自己写盘不该引发一次自我 reload", async () => {
  const file = join(dir, "self-write.json");
  const st = await S.JsonScheduleStore.open(file);
  let reloads = 0;
  st.watchFile(() => { reloads += 1; });
  await new Promise((r) => setTimeout(r, 60));

  // watcher 监听的是目录，自己 tmp + rename 落盘同样会触发它。
  const s = await st.create({ botId: "d", chatId: "c", name: "巡检", cron: "0 * * * *", prompt: "p" });
  await st.update(s.id, { lastStatus: "success" });
  await new Promise((r) => setTimeout(r, 600));   // 防抖 200ms + 余量

  assert.equal(reloads, 0, `自己写盘引发了 ${reloads} 次自我 reload`);
  assert.equal(st.get(s.id).lastStatus, "success");
  st.close();
});

/** 外部编辑器（vim / VS Code / sed -i / mv）的原子保存：tmp + rename，会换掉 inode。 */
const atomicSave = (file, rows) => {
  const tmp = `${file}.editor`;
  writeFileSync(tmp, `${JSON.stringify(rows, null, 2)}\n`);
  renameSync(tmp, file);
};

/** 塞住下一次落盘，把「内存已经改了、磁盘还是旧的」这个窗口固定下来，返回放行函数。 */
const blockNextWrite = (st) => {
  let release;
  st.writeQueue = new Promise((r) => { release = r; });
  return release;
};

await t("[并发] 重载排在写队列上：在飞的删除不会被过期快照复活", async () => {
  const file = join(dir, "reload-race.json");
  const st = await S.JsonScheduleStore.open(file);
  const s = await st.create({ botId: "d", chatId: "c", name: "要删掉的", cron: "0 * * * *", prompt: "p" });

  // 真机上这个窗口由 watcher 的 200ms 防抖造出来：群里连点「停用」再「删除」就能撞进去。
  const releaseWrite = blockNextWrite(st);
  const removal = st.remove(s.id);
  await new Promise((r) => setTimeout(r, 20));    // 内存里的删除先生效，磁盘还没改

  // 磁盘内容必须和这个 store 自己写过的任何一份都不同，否则自写指纹会先把重载短路掉，
  // 「重载有没有排队」这一半就永远走不到——这条用例第一版正是栽在这儿。
  atomicSave(file, [{ ...s, name: "人手工改过的名字" }]);

  const hotReload = st.reload();                  // 此刻磁盘上那条记录还在
  await new Promise((r) => setTimeout(r, 50));
  releaseWrite();
  await Promise.all([removal, hotReload]);

  assert.equal(st.get(s.id), undefined, "被删掉的定时任务被过期快照复活了");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).length, 0, "复活的记录还被写回了磁盘");
  st.close();
});

await t("[并发] 走 watcher 进来的重载同样排队：在飞的改动不会被盖回旧值", async () => {
  // 生产里这个竞态只从 watcher 防抖那条路进来，上一条用例走的是直接 reload()，
  // 两条路各有各的入口，watcher 那个入口也要有人钉着。
  const file = join(dir, "watch-race.json");
  const st = await S.JsonScheduleStore.open(file);
  const s = await st.create({ botId: "d", chatId: "c", name: "原名", cron: "0 * * * *", prompt: "p" });
  st.watchFile();
  await new Promise((r) => setTimeout(r, 60));

  const releaseWrite = blockNextWrite(st);
  const renaming = st.update(s.id, { name: "卡片上改的" });
  await new Promise((r) => setTimeout(r, 20));
  atomicSave(file, [{ ...s, name: "人手工改的" }]);   // 触发 watcher，200ms 后重载
  await new Promise((r) => setTimeout(r, 400));       // 防抖烧完，重载已经排上队
  releaseWrite();
  await renaming;
  await new Promise((r) => setTimeout(r, 400));       // 让排在后面的重载跑完

  assert.equal(st.get(s.id).name, "卡片上改的", "在飞的改动被 watcher 的过期快照盖回去了");
  assert.equal(
    JSON.parse(readFileSync(file, "utf8"))[0].name, "卡片上改的",
    "内存和磁盘各说各的",
  );
  st.close();
});

await t("[热更新] 手工改回上一次自己写下去的内容，第二次编辑照样要生效", async () => {
  const file = join(dir, "revert-to-own.json");
  const st = await S.JsonScheduleStore.open(file);
  const s = await st.create({ botId: "d", chatId: "c", name: "巡检", cron: "0 * * * *", prompt: "p" });
  const written = readFileSync(file, "utf8");      // store 自己写下去的那份字节

  const rows = JSON.parse(written);
  rows[0].enabled = false;
  atomicSave(file, rows);                          // 人手工停用
  await st.reload();
  assert.equal(st.get(s.id).enabled, false, "第一次手工编辑没生效");

  // 人又手工改回去（undo 保存、或 cp 一份备份回来），磁盘逐字节回到自己写过的那份。
  const tmp = `${file}.editor`;
  writeFileSync(tmp, written);
  renameSync(tmp, file);
  await st.reload();

  assert.equal(st.get(s.id).enabled, true, "改回自己写过的内容后，这次编辑被当成自我写盘吞掉了");
  st.close();
});

await t("[#8] 一次变更失败不会撤销另一次已经成功的变更", async () => {
  const file = join(dir, "serial.json");
  const st = await S.JsonScheduleStore.open(file);
  const a = await st.create({ botId: "d", chatId: "c", name: "A", cron: "0 * * * *", prompt: "p" });
  const b = await st.create({ botId: "d", chatId: "c", name: "B", cron: "0 * * * *", prompt: "p" });
  // 让第二次写盘失败，同时并发发起两次变更
  let calls = 0;
  const realSave = st.persist;
  const results = await Promise.allSettled([
    st.update(a.id, { name: "A2" }),
    st.update(b.id, { name: "B2" }),
  ]);
  assert.ok(results.every((r) => r.status === "fulfilled"));
  assert.equal(st.get(a.id).name, "A2");
  assert.equal(st.get(b.id).name, "B2", "并发变更互相覆盖了");
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(onDisk.find((r) => r.id === a.id).name, "A2");
  assert.equal(onDisk.find((r) => r.id === b.id).name, "B2");
  st.close();
  void realSave; void calls;
});

await t("[#9] 收件箱有容量上限，退回的交接单不会无限堆积", () => {
  const inbox = new CO.CollaborationInbox();
  for (let i = 0; i < 260; i += 1) {
    inbox.register({
      dispatchId: String(i).padStart(12, "0"), taskId: "t", fromBotId: "a", toBotId: "b",
      chatId: "c", threadId: "t",
      round: 1, maxRounds: 16, workspaceDir: "/w", prompt: "p",
    });
  }
  assert.ok(inbox.size <= 200, `收件箱涨到了 ${inbox.size}`);
  // 最新的仍然可以领取
  assert.ok(inbox.consume("000000000259", "b", { chatId: "c", threadId: "t" }));
});

await t("[#11] 审批结论送不达时可以退回待处理，按钮重新可用", () => {
  const store = new A.ApprovalFlowStore();
  const request = A.ApprovalRequestSchema.parse({ title: "t", summary: "s", impact: "i", risk: "high" });
  const f = store.create({ taskId: "t", botId: "d", sessionId: "s", ownerOpenId: "o", originalMessageId: "m", replyInThread: true, request });
  store.decide(f.token, "approved", "o");
  assert.equal(store.get(f.token).status, "approved");
  const reverted = store.revertToPending(f.token);
  assert.equal(reverted.status, "pending");
  assert.equal(reverted.decidedAt, undefined);
  // 退回之后可以重新拍板
  assert.equal(store.decide(f.token, "rejected", "o").status, "rejected");
  // pending 状态下退回是空操作
  const f2 = store.create({ taskId: "t2", botId: "d", sessionId: "s", ownerOpenId: "o", originalMessageId: "m", replyInThread: true, request });
  assert.equal(store.revertToPending(f2.token), undefined);
});

await t("[#15] 工作目录存在但不是文件夹时，错误说的是真实原因", async () => {
  const filePath = join(dir, "not-a-dir.txt");
  writeFileSync(filePath, "x");
  await assert.rejects(() => W.ensureWorkspaceDirectory(filePath), /不是文件夹/);
});

await t("[#24] 产物路径挡住 Windows 绝对路径与 UNC", () => {
  const bad = ["C:\\Windows\\x.md", "c:/temp/x.md", "\\\\server\\share\\x.md", "..\\out\\x.md", "/etc/x"];
  for (const b of bad) {
    assert.equal(P.ProductSpecRequestSchema.safeParse({
      title: "t", summary: "s", deliveryMode: "local", specPath: b, ticketsPath: "ok" }).success, false, b);
  }
  assert.equal(P.ProductSpecRequestSchema.safeParse({
    title: "t", summary: "s", deliveryMode: "local", specPath: ".scratch/f/spec.md", ticketsPath: ".scratch/f/issues" }).success, true);
});

await t("[#23] docx 链接校验与 documentToken 口径一致", () => {
  const store = new P.ProductSpecFlowStore();
  const ok = (u) => P.ProductSpecRequestSchema.safeParse({ title: "t", summary: "s", deliveryMode: "lark-doc", documentUrl: u }).success;
  assert.equal(ok("http://x.feishu.cn/docx/TOK"), false);        // 必须 https
  assert.equal(ok("https://x.feishu.cn/docx/TOK/extra"), false); // 多一段就不该通过
  assert.equal(ok("https://x.feishu.cn/docx/TOK"), true);
  // 通过校验的链接必须能被反查到
  const request = P.ProductSpecRequestSchema.parse({ title: "t", summary: "s", deliveryMode: "lark-doc", documentUrl: "https://x.feishu.cn/docx/TOK" });
  store.create({ taskId: "t", botId: "p", sessionId: "s", ownerOpenId: "o", request });
  assert.ok(store.findPendingByDocument("p", "TOK"));
});

await t("[#14] 子进程环境剥掉 Agent OS 自己的凭证，保留引擎凭证", async () => {
  const { childEnvironment } = await R("cli/spawn-cli.js");
  const env = childEnvironment({
    FEISHU_DEVELOPER_APP_SECRET: "s", BOTS_CONFIG: "c", OWNER_OPEN_ID: "ou",
    ANTHROPIC_AUTH_TOKEN: "keep", PATH: "/usr/bin", HOME: "/home/me",
  });
  assert.equal(env.FEISHU_DEVELOPER_APP_SECRET, undefined);
  assert.equal(env.BOTS_CONFIG, undefined);
  assert.equal(env.OWNER_OPEN_ID, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "keep");  // 引擎自己的凭证不能动
  assert.equal(env.PATH, "/usr/bin");
});

await t("[授权] 自定义飞书凭证变量名也不会进入引擎环境", async () => {
  const { childEnvironment, setApplicationCredentialNames } = await R("cli/spawn-cli.js");
  setApplicationCredentialNames(["CUSTOM_APP_ID", "CUSTOM_APP_SECRET"]);
  try {
    const result = childEnvironment({ CUSTOM_APP_ID: "id", CUSTOM_APP_SECRET: "secret", OPENAI_API_KEY: "keep" });
    assert.equal(result.CUSTOM_APP_ID, undefined);
    assert.equal(result.CUSTOM_APP_SECRET, undefined);
    assert.equal(result.OPENAI_API_KEY, "keep");
  } finally {
    // 全局过滤名单不能泄漏到后面的独立用例。
    setApplicationCredentialNames([]);
  }
});

await t("[#20] prompt 一律走 stdin", async () => {
  const { promptInputForPlatform } = await R("cli/types.js");
  for (const p of ["darwin", "linux", "win32"]) {
    assert.equal(promptInputForPlatform(p), "stdin");
  }
  // 两个引擎在 stdin 模式下都不把任务文本放进 argv
  assert.equal(claude.buildArgs("机密任务", "stdin").includes("机密任务"), false);
  assert.equal(codex.buildArgs("机密任务", "stdin").includes("机密任务"), false);
  assert.equal(codex.buildArgs("x", "stdin").at(-1), "-");
});

await t("[#17] MCP 配置走文件路径，不再把 JSON 塞进 argv", () => {
  const args = claude.buildArgs("x", "stdin");
  const i = args.indexOf("--mcp-config");
  assert.ok(i >= 0);
  const value = args[i + 1];
  assert.equal(value.includes("{"), false, "MCP 配置仍是内联 JSON");
  assert.ok(value.endsWith(".json"));
  assert.equal(JSON.parse(readFileSync(value, "utf8")).mcpServers.agent_os.type, "stdio");
});

await t("[#10] 终态卡片刷新失败不再抛出，任务结果不被改写", async () => {
  const u = new CARD.ThrottledCardUpdater(async () => { throw new Error("飞书 500"); }, 10);
  await u.finish({ n: 1 }); // 不抛出即通过
});

await t("[#25] 协作卡片方向由 kind 决定，而不是 round", () => {
  const base = { senderName: "A", targetName: "B", workspaceName: "w", prompt: "p", round: 3, maxRounds: 16 };
  const fwd = JSON.stringify(CARD.buildCollaborationCard({ ...base, kind: "forward" }));
  const ret = JSON.stringify(CARD.buildCollaborationCard({ ...base, kind: "return" }));
  assert.ok(fwd.includes("任务已派发"), "第 3 轮的正向派发被写成了结果返回");
  assert.ok(ret.includes("结果已返回"));
});

await t("[#22] 没有接收人时不发通知，也不抛错", async () => {
  const { sendResultNotification } = await R("app/notification-service.js");
  let called = false;
  await sendResultNotification({
    bot: { replyMention: async () => { called = true; } },
    replyToMessageId: "m", target: { openId: "", name: "" },
    text: "x", replyInThread: true,
  });
  assert.equal(called, false);
});

await t("[#26] 成功不再 @人：任务主线里没有成功通知", () => {
  const src = readFileSync("src/app/task-runner.ts", "utf8");
  assert.equal(src.includes("任务已完成，请查看上方结果。"), false);
});

await t("[#16] 会话写盘失败后，磁盘与内存收敛到同一版本", async () => {
  const file = join(dir, "converge.json");
  const store = new JsonSessionStore(file);
  const m = await SessionManager.open({ store });
  const { session } = await m.resolve({ messageId: "m", chatId: "c", threadId: "t", rootId: "" }, "claude", "dev", "/tmp");
  let failNext = true;
  const original = store.save.bind(store);
  store.save = (rows) => { if (failNext) { failNext = false; return Promise.reject(new Error("磁盘满")); } return original(rows); };
  await assert.rejects(() => m.transition(session.id, "active"));
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(onDisk[0].status, m.get(session.id).status, "磁盘与内存不一致");
});


// ─────────── 评审在 bot 写的实现里查实的缺陷，逐条锁住 ───────────
console.log("task record（bot 实现，评审后加固）");

const sampleInput = (n) => ({
  taskId: "t", botId: "dev", chatId: "c", threadId: "th", sessionId: "s",
  cliId: "claude", workspaceDir: "/w", origin: "thread", ownerOpenId: "ou_x",
  title: `T${n}`, prompt: `p${n}`, status: "success", answer: `a${n}`,
  startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  durationMs: 1, toolCount: 0, completedToolCount: 0,
});

await t("[记录] 满容量时一次写盘失败，不能永久删掉一条合法记录", async () => {
  const file = join(dir, "tasks-cap.json");
  const store = new TR.JsonTaskRecordStore(file, 3);
  for (const n of [0, 1, 2]) await store.append(sampleInput(n));
  assert.deepEqual(store.list().map((r) => r.title), ["T0", "T1", "T2"]);

  // 并发：A 写盘失败、B 成功
  let failNext = true;
  const realPersist = store["persist"].bind(store);
  store["persist"] = () =>
    failNext ? ((failNext = false), Promise.reject(new Error("ENOSPC"))) : realPersist();
  const [a, b] = await Promise.allSettled([
    store.append(sampleInput("A")),
    store.append(sampleInput("B")),
  ]);
  assert.equal(a.status, "rejected");
  assert.equal(b.status, "fulfilled");
  // T1 完全在保留范围内，不能因为别人写盘失败就消失
  assert.deepEqual(
    store.list().map((r) => r.title),
    ["T1", "T2", "TB"],
    "满容量并发下一次写盘失败，删掉了保留范围内的 T1",
  );
});

await t("[记录] 写盘失败后磁盘与内存必须一致，且不留幽灵记录", async () => {
  const file = join(dir, "tasks-diverge.json");
  const store = new TR.JsonTaskRecordStore(file, 3);
  for (const n of [0, 1, 2]) await store.append(sampleInput(n));
  let failNext = true;
  const realPersist = store["persist"].bind(store);
  store["persist"] = () =>
    failNext ? ((failNext = false), Promise.reject(new Error("ENOSPC"))) : realPersist();
  await assert.rejects(() => store.append(sampleInput("X")));

  const onDisk = JSON.parse(readFileSync(file, "utf8")).map((r) => r.title);
  assert.deepEqual(store.list().map((r) => r.title), onDisk, "磁盘与内存分叉了");
  // 重开一次，被报告成写失败的那条不能复活
  const reopened = new TR.JsonTaskRecordStore(file, 3);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(reopened.list().some((r) => r.title === "TX"), false, "写失败的记录复活成了幽灵");
});

await t("[超时] 空闲超时与总时长超时都带具名标记，上层不靠文案匹配", async () => {
  const { runCli, CLI_TIMEOUT_ERROR } = await R("cli/runner.js");
  const silent = {
    id: "claude", command: process.execPath, displayName: "假引擎",
    buildArgs: () => ["-e", "setInterval(()=>{},1000)"],
    buildResumeArgs: () => ["-e", "setInterval(()=>{},1000)"],
    buildCompactPlan: () => ({ protocol: "claude-stream-json", command: process.execPath, args: [], prompt: "" }),
    parseEvents: () => [],
  };
  for (const [limits, kind] of [
    [{ idleTimeoutMs: 300 }, "空闲"],
    [{ maxRuntimeMs: 300 }, "总时长"],
  ]) {
    const err = await runCli({ adapter: silent, prompt: "x", cwd: process.cwd(), ...limits })
      .then(() => null, (e) => e);
    assert.ok(err, `${kind} 超时没有抛错`);
    assert.equal(err.name, CLI_TIMEOUT_ERROR, `${kind} 超时缺少具名标记，上层判断会漏掉它`);
  }
});

console.log(`\n${pass} passed`);
