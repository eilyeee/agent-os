# AGENTS.md

Guidance for AI coding agents working in this repository.

---

## What this project is

Agent OS turns Lark/Feishu into a command deck for headless AI coding CLIs
(Claude Code, Codex and DeepSeek Harness). One Lark thread is one task; multiple bots hand work to
each other; a scheduler dispatches work on its own.

**We do not call model APIs.** There is no AI SDK dependency and there never
should be. Model calls, tool execution and context management belong to Claude
Code / Codex. This repository is the **command layer above them**: tasks,
sessions, agents, permissions, working directories, scheduling.

### Out of scope — reconsider the design if you find yourself here

- Talking to a model provider directly, or adding an AI SDK dependency
- An HTTP server or webhook endpoint — ingress is a WebSocket long connection by
  design, so the whole thing runs on a laptop with no public IP
- Reimplementing what the engines already do natively (context compaction,
  session history, tool execution)
- A second source of truth for anything already persisted

---

## Setup and commands

Requires **Node.js 22.13+** and **pnpm 11.5.3**.

```bash
pnpm install
cp .env.example .env                       # then fill in credentials
cp config/bots.example.json config/bots.json

pnpm dev          # tsx watch — reloads on src/, .env and config/*.json changes
pnpm start:once   # single run, no watch
pnpm build        # tsc — run this after every change set
pnpm check        # build + pure-logic tests (scripts/smoke.mjs)
pnpm integration  # build + orchestration tests against a fake Lark (scripts/integration.mjs)
pnpm verify       # both of the above — run this before reporting anything done
pnpm probe:cli    # pipe a CLI event stream into the timeline parser
pnpm probe:tool   # exercise the local MCP tools without touching Lark
```

`pnpm build` is the fast feedback loop — run it after each coherent change, not at
the end of a large edit. Before reporting anything done, run `pnpm verify`:

- `check` covers pure logic — schemas, state machines, persistence, migrations,
  cron, event parsing, card rendering — against the build output.
- `integration` drives the real orchestration (`app/` + `core/`) through a fake Lark
  (`scripts/fakes.mjs`): command dispatch, card callbacks, the clarification and
  approval flows, ownership checks, session routing. The fake implements the real
  `Bot` interface and the fixtures use real Lark payload shapes.

Neither covers the Lark long connection itself or the CLI subprocesses. Those two
layers are only ever proven in a real workspace against real engines — a green
`pnpm verify` is necessary, never sufficient.

---

## Architecture: layers and the one hard rule

```
src/index.ts                   只做接线：加载配置、启动 bot、挂调度器
src/im/     ingress            飞书 SDK、事件收敛、卡片构建
  lark.ts                      长连接 + REST + 三类事件分发
  message-parser.ts            正文提取、@提及还原、富媒体 key
  card.ts                      全部卡片构建 + ThrottledCardUpdater
    buildHistoryCard           /history 列表卡：状态筛选、翻页、每行一个详情入口
    buildHistoryDetailCard     单条历史的详情卡：完整答案、执行统计、返回列表
src/core/   kernel             领域逻辑，不依赖任何消息平台
  session-manager.ts           会话模型与状态机
  session-store.ts             崩溃安全落盘 + 旧数据迁移
  command-parser.ts            斜杠命令解析
  workspace.ts                 工作目录解析与校验
  access-control.ts            人员与群的授权名单，默认仅负责人可访问
  topic-task.ts                话题 → 稳定 taskId
  bot-registry.ts              bots.json 解析 + 提示词组装
  team-registry.ts             团队名册 + Skill 存在性检查
  task-progress.ts             高频事件 → 稳定快照
  task-abort.ts                停止任务的权限与状态收敛
  task-record.ts               任务历史：结局状态、滚动落盘、按群按 bot 查询与筛选
  collaboration.ts             交接单、收件箱、dispatch_task 契约
  clarification.ts             需求澄清契约 + 逐题流程
  product-spec.ts              产品方案契约 + 确认状态
  product-spec-store.ts        确认状态落盘
  approval.ts                  审批门契约与状态
  cron.ts                      五段式 cron 匹配 + 下次触发时间推算（同一份日期判据）
  schedule.ts                  定时任务模型 + 热更新存储
src/cli/    engines            引擎差异，收敛成统一 CliEvent
  types.ts                     CliAdapter / CliEvent / CliRunResult 契约
  spawn-cli.ts                 跨平台 spawn + 杀进程树
  runner.ts                    通用 Runner：超时 / 取消 / 事件分发
  claude-adapter.ts            Claude Code 参数与 stream-json 解析
  codex-adapter.ts             Codex 参数与 JSONL 解析
  dsh-adapter.ts               DeepSeek Harness headless 参数、JSONL 与会话续接
  dsh-runtime-bridge.ts         DSH 原生插件源码：工具就绪门、任务树校验、无损结果与后代用量
  registry.ts                  引擎注册表
  app-tools.ts                 应用工具名 + MCP 挂载参数
  native-sessions.ts           读取引擎原生历史会话
  native-compact.ts            调用引擎原生 /compact
src/app/    orchestration      决定一条消息怎么流动
  runtime.ts                   进程内共享状态（含引擎查找 getAdapter）
  message-router.ts            一条飞书消息怎么走：交接认领与退回、准入、澄清接续
  task-runner.ts               任务主线：一次 CLI 执行的完整生命周期
  task-history.ts              普通任务与文档评论共用的轮次历史与成本落盘
  command-handler.ts           斜杠命令分发
  card-action-handler.ts       卡片按钮回调
  collaboration-service.ts     派活：登记交接单 + 卡片 + @通知
  clarification 续跑           由 task-runner 的 resumeSession 承担
  product-comment-runner.ts    云文档评论评审、评论内澄清与其他应用请求退回话题
  scheduler.ts                 定时触发 → 开话题 → 走同一条主线
  commands.ts                  命令清单的唯一来源：/help 与两篇 README 都对照它
  cli-execution.ts             调用引擎的唯一入口
  notification-service.ts      结果通知
  session-view.ts              状态展示与收尾
  history-view.ts              /history 取数 + 渲染，命令与卡片回调共用一份
  product-spec-documents.ts    产品产物落盘校验
src/mcp/    tools              本地 MCP Server（stdio）
  app-tools-server.ts          五个应用工具的参数契约
scripts/smoke.mjs              纯逻辑冒烟测试
scripts/fakes.mjs              假飞书 + 假引擎（真子进程按脚本吐 CliEvent）
scripts/integration.mjs        编排层集成测试
ecosystem.config.cjs           pm2 常驻配置
docs/deployment.md             首次部署、授权名单、隔离边界与真机验收
```


| Layer | Does | Must never do |
|---|---|---|
| `im/` | Talk to Lark, build cards | Business decisions (may this task start? who may stop it?) |
| `core/` | Domain logic | **Depend on any messaging platform** |
| `cli/` | Engine differences | Know about Lark or business rules |
| `app/` | Orchestration | Call the Lark SDK or `spawn` directly |
| `mcp/` | Parameter contracts | Contain execution logic |

> **Hard rule:** `core/` importing from `im/` is a design error. The kernel must
> survive replacing Lark with something else. Reject any change that violates this.

Files are `kebab-case.ts`. When you add a module, extend the tree above with a
one-line description of what it owns — this listing is the module map.

---

## Domain model you need to know

**Session — one thread is one session.**

```
session key  = `${botId}:${chatId}:${threadId}`
threadId     = message.threadId || message.rootId || message.messageId
```

Two session layers, never conflate them:

- `session.id` — ours. Routes messages, tracks task state.
- `session.cliSessionId` — the CLI's. Restores model conversation context via
  `claude --resume <id>`, `codex exec resume <id>` or `dsh --profile headless --session-id <id>`.

State machine, enforced by `ALLOWED_TRANSITIONS` (illegal transitions throw):

```
creating → active | idle | closed
active   → idle | closed
idle     → active | closed
closed   → (terminal)
```

`creating → idle` exists so a brand-new thread whose first message is `/cd` or
`/help` — commands that create a session but start no CLI — does not get stuck.

**CliEvent — the type that erases engine differences.** Adapters translate raw
protocol into `session | tool_start | tool_end | context | tool_call | result |
error`. Everything above `cli/` consumes only this.

**Task history — one record per CLI turn**, rolling 500 in `data/tasks.json`,
scoped in every view to one chat + one bot. A turn ends in exactly one outcome, and
**"finished" and "waiting on a human" are different outcomes**:

```
success    跑完了，答案就在本话题里
forwarded  这一轮做完了，结果流转了出去（定时任务已生效 / 活派给了队友）
waiting    停在半路等人拍板（审批 / 需求澄清 / 产品方案卡还挂着）
failed / cancelled
handoff    只在老记录里：拆分之前 forwarded 与 waiting 共用这一个取值
```

Do not confuse this with `origin: "handoff"`, which is still written on every turn
and means something else entirely — *where the task came from* (a teammate handed it
over), not how it ended.

The `/history` "成功" filter is `success + forwarded`. `waiting` and legacy
`handoff` appear only under "全部" — a person filtering for 成功 is confirming
progress, and a task still waiting on their own decision must not be sitting there.
Old `handoff` rows are kept verbatim (no field can tell the two meanings apart, so
rewriting them would be guessing on the user's behalf) and labelled as old records.

**Collaboration handoff.** The Lark message carries only a `dispatchId` (a claim
ticket). The real payload lives in a shared `CollaborationInbox`; the target bot
calls `consume(dispatchId, myBotId, deliveryScope)`, which validates the original
chat and topic before it **deletes on claim**, so one notice can
never execute twice. Dedup key: `taskId:round:toBotId:dispatchId` — it must identify
*this delivery*, not just "the Nth round in this thread", or two separate tasks in one
thread that both route to the same reviewer collide and the second is silently dropped.
`round`/`maxRounds` cap bot-to-bot ping-pong. The target bot must have an
authorized human owner both when dispatching and claiming. Delivery scope is
in-memory inbox state, not a new persisted session field.

---

## Conventions

### Code

- **ESM only.** `"type": "module"`, Node 22+, `.js` extensions in relative imports.
- **Validate every external input with Zod** — Lark events, CLI event lines,
  config files, MCP tool arguments. Nothing untrusted reaches domain logic unparsed.
- **`spawn()` takes an argument array. Never build a shell string.** Quotes,
  newlines and `$()` arriving from Lark must stay inert data.
- **Atomic writes.** Persist as `file.tmp` then `rename()`. Serialize concurrent
  writes through a queue. On write failure, roll the in-memory value back — disk
  and memory must not diverge.
  Session reads, checks and mutations all belong inside the queue; publish a new
  snapshot only after saving succeeds. Task admission checks both pending writes
  and whether the prepared workspace / engine binding is still current.
- **Every new persisted field needs a migration branch.** Backfill old records in
  `load()` before Zod validation, then rewrite the file. Never tighten a schema in
  a way that discards existing user sessions.
- **Secrets live in `.env` only.** `config/*.json` stores *environment variable
  names*, not values. Model backends belong to each CLI's own user-level config
  (`~/.claude/settings.json`), never to this repo.
- **Always restore session state in `finally`.** A card send failure, a missing
  `message_id` or an unexpected exit must all return the session to `idle`.
  A session stuck in `active` silently rejects every later message in that thread.

### Comments

Comment the **why**, never the **what**. Clear code needs no gloss; code that
*looks* wrong but is correct always does. Comments are written in Chinese, matching
the domain vocabulary (话题 / 会话 / 卡片).

Required:

- **A one-line header on every file**, saying what it owns.
- **Platform branches** — name what breaks without them.
  `// Windows: cmd 不转义 argv，中文 prompt 会乱码 → 走 stdin`
- **Protocol quirks and workarounds** — name the external behaviour being worked around.
  `// 飞书把 content 作为 JSON 字符串嵌在事件 JSON 里，要再 parse 一次`
- **Transitions and guards that look wrong** —
  `// creating → idle：新话题首条是 /cd 时会建会话但不启动 CLI`
- **Rollback and `finally` blocks** — say which invariant is being protected.
  `// 回滚内存值：磁盘和内存不能出现两个版本`
- **Dedup and idempotency keys** — spell out which duplicate they prevent.
- **Every magic number gets a unit and a reason.** Prefer a named constant:
  `const CARD_THROTTLE_MS = 1_000; // 飞书频控 + 人眼也读不了更快`

Do not comment what the next line obviously does, types the signature already
states, or change history — that is git's job. A comment that restates the code is
worse than none, because it drifts.

### User-facing copy

Every string a person reads in Lark is product surface.

- Bot replies, card text, toasts and error messages are written in **Chinese**.
- An error says what happened and what to do next. No apologies, no raw stack
  traces in the headline — technical detail goes in the card's collapsed section.
- Keep a final answer under roughly 1200 Chinese characters. Long artifacts are
  written to files or a cloud doc; the reply carries a summary and a path.

---

## Extending the system

**Add a CLI engine**

1. `src/cli/<name>-adapter.ts` implementing `CliAdapter` — three methods:
   `buildArgs`, `buildResumeArgs`, `parseEvents`.
2. Register in `src/cli/registry.ts`; widen `CliId`.
3. Widen the `cliId` enum in `session-store.ts` **and add a migration branch**.
4. Add its MCP mount flags to `src/cli/app-tools.ts`.

Nothing above `cli/` should need to change. If it does, the abstraction leaked —
fix the adapter, not the caller.

**Add an MCP app tool**

1. Zod schema in `src/core/<feature>.ts`, plus a `find<Feature>Request(toolCalls)`
   helper that scans backwards for the newest valid call.
2. Register it on `src/mcp/app-tools-server.ts`.
3. Emit `tool_call` from **both** adapters — Claude prefixes the name with
   `mcp__agent_os__`, Codex reports `server` and `tool` separately.
4. Handle the result in `src/app/`.
5. Verify with `pnpm probe:tool` **before** wiring anything into Lark. Debugging the
   tool contract and the card flow at the same time wastes an afternoon.

**Add a slash command**

1. Extend `SlashCommand`, the regex, **and `KNOWN_COMMANDS`** in
   `core/command-parser.ts` — the last one is what tells a real command from a typo.
2. Handle it in `app/command-handler.ts`, returning `handled` or `continue`.
3. Add it to `COMMAND_DOCS` in `app/commands.ts` — `/help` renders from there.
4. Add the same row to the command tables in `README.md` and `README.zh-CN.md`.

Steps 1, 3 and 4 are each pinned by a test, so forgetting one turns red rather than
drifting: the Chinese README table must equal `COMMAND_DOCS` verbatim, `/help`'s real
reply must equal it line for line, and `KNOWN_COMMANDS` must carry the same names.

A command branch must return before the task pipeline starts, or it will also kick
off a CLI run.

**Add a bot**

Add an entry to `config/bots.example.json` and `config/bots.json`, plus two
variables in `.env`. No code change. If a new role seems to need code, first ask
whether it should be a Lark bot at all — see below.

---

## Product principles that constrain code

**Summarize normally, @ someone only on exception.** Progress belongs on the card,
refreshed in place — it is a status panel, not a feed. Failures and decisions
trigger a notification. Push on every step and users mute the bot.

**Bot count is not team capability.** Only a role that *both* holds long-lived
context *and* talks to humans directly earns a Lark bot. Today that is three: CEO
assistant, product manager, developer. Code review and testing run as sub-agents
inside the developer's CLI so their process noise never floods the thread.

**For anything a human sees:** show only what they need to care about, and put them
in the room for anything they must decide. Hide the rest.

---

## Gotchas that will cost you an afternoon

**Lark**

1. `content` is **double-encoded JSON**. The SDK parses the outer event; `m.content`
   is still a string that needs another `JSON.parse`.
2. @-mentioning a bot usually delivers `message_type: "post"` (rich text), not `text`.
3. Cards need `config.update_multi: true` or updates will not propagate to other viewers.
4. **Patching an existing card does not fire an @-mention notification.** To
   actually reach a target bot you must send a *new* rich-text message. Card carries
   the information, new message carries the ping.
5. Serialize card updates through a promise chain — a late-arriving earlier request
   will otherwise roll the card back to a stale state.

**CLI subprocesses**

6. On Windows `claude`/`codex` are `.cmd` shims requiring `shell: true`, but cmd
   does not escape arguments — a Chinese prompt gets mangled and the agent replies
   "I don't understand". **Pass the prompt via stdin on every platform.** Windows
   cancellation needs `taskkill /T` to kill the whole process tree.
7. stdout is a byte stream; one `data` event may hold half a line. Use `readline`
   and skip lines that fail to parse (Codex prints non-JSON logs while reconnecting).
8. Guard promise settlement — `error` and `close` must not both resolve/reject.
9. **Context accounting has two meanings.** In-flight `assistant.message.usage` is
   *current context*; final `result.usage` is *cumulative spend for the whole run*.
   Mixing them produces "context 260.6k / 200k".
10. Engines are not interchangeable mid-thread. Claude and Codex session ids are not
    compatible. `cliId` is fixed at thread creation; switching means a new thread.
11. Codex splits the answer and the usage stats across two events — the runner must
    buffer and merge them.

---

## Safety

Running headless inside Lark means there is no interactive permission prompt, so
the engines are launched with `--dangerously-skip-permissions` / `--yolo`. This is
the largest risk surface in the project.

- Only ever point a bot's `workspace` at a directory you trust and can roll back.
- Tag a baseline (`git tag baseline`) in demo workspaces before running handoffs.
- High-risk operations must go through the approval gate, not around it.
- Never widen these flags to a directory a user did not explicitly configure.

---

## Working style in this repo

- Build in the order of the roadmap in `README.md`. The painful bugs cluster in
  cross-platform spawn, event-stream parsing and state cleanup; skipping ahead means
  hitting several at once.
- After each change set: `pnpm build`, then verify the behaviour in a real Lark
  thread. **A passing type check is not evidence a feature works** — do not report
  one as done on that basis.
- Keep the mistakes log honest. It is the cheapest way to stop the next agent from
  repeating a debugging session you already paid for.

---

## Definition of done

Writing the code is not finishing. Before reporting a change set complete, run a
**separate review pass over your own diff** — a fresh read, not a rationalisation
of what you just wrote. Reviewing inline while coding only confirms the
assumptions you already made.

**Delegate it.** Two subagents live in `.claude/agents/`. Spawn them — do not do
these two passes in the main context:

| Subagent | What it does |
|---|---|
| `tester` | Runs the suites, then **breaks each new test's implementation on purpose** to prove the test actually goes red |
| `code-reviewer` | Reads the diff cold against the lenses below, reports only findings with a concrete failure scenario |

Two reasons this is a delegation and not a checklist item. A fresh context cannot
rationalise code it never wrote — that is exactly the "fresh read" this section asks
for, made mechanical. And the process noise (forty files read, six test runs, an
implementation broken and restored) stays out of the conversation the human is
reading; only the verdict comes back.

The tool that spawns them is the subagent tool — depending on the build it is
surfaced as `Agent` or `Task`, and it takes the subagent name (`tester`,
`code-reviewer`) as its type. **Do not go looking for one exact tool name and give up
when it is missing**: a real engine once read "if you have a Task tool", saw its own
tool was called `Agent`, and quietly skipped both passes.

If you genuinely cannot spawn a subagent, run both passes yourself — the standard does
not drop, only the delegation does — and **say so explicitly in your report**, so the
fallback is visible instead of silent.

### When to escalate to a different model

The `code-reviewer` subagent runs on the same engine you do, so it shares your priors.
That is fine for most defects — it caught plenty — but it is structurally blind to the
class where *both of you believe the same wrong thing*. A different model is not
smarter; it is wrong in different places.

`reviewBy` (an automatic cross-bot review after every turn) is **off by default**: on a
real day it consumed roughly three quarters of the token spend, much of it reviewing
changes that needed no review. Escalate deliberately instead — `dispatch_task` to a bot
running the other engine — when the change is one of:

- **A security boundary**: who may do what, or which scope a request is confined to
- **Persisted-data semantics**: a field changing meaning, a migration, a new status
- **Correctness that rests on an external protocol's behaviour**: what Feishu delivers,
  what an engine CLI emits, what an id is scoped to
- **Anything the `code-reviewer` subagent flagged but could not settle**

These are the categories that actually bit this project. The cross-model reviewer once
caught a pointer that named "本话题" in a feature that is explicitly cross-thread —
a wrong shared assumption, not a coding slip.

Walk the diff once per lens. Each lens asks a different question, and each catches
a class of bug the others miss.

| Lens | The question |
|---|---|
| **Layering** | Does `core/` reach into `im/`? Does `app/` spawn or call the Lark SDK directly? Did engine-specific knowledge leak above `cli/`? |
| **State cleanup** | Does *every* exit path — success, failure, abort, timeout, early return — put the session back to `idle` and drop its `activeRuns` entry? |
| **Subprocess safety** | Argument arrays only, never a shell string. Prompt through stdin. Cancellation kills the whole process tree. |
| **Persistence** | Atomic write, serialized, rolled back on failure. New field → migration branch. Does an existing `sessions.json` still load? |
| **Validation** | Is every external input parsed by Zod before it reaches domain logic? |
| **Concurrency & idempotency** | Can this handler run twice for one event? Is the dedup key unique per turn? Do card updates stay ordered under load? |
| **Cross-platform** | What does this do on Windows? Is there a `process.platform` branch, and is it commented? |
| **Failure modes** | What happens when Lark returns an error, the CLI exits non-zero, the process is killed mid-write, the network drops? |
| **User-facing copy** | Chinese, says what to do next, technical detail collapsed, inside the length budget. |
| **Comments** | Is every non-obvious branch explained? Any comment that merely restates the code? Any bare magic number? |
| **Secrets** | Credentials out of code, config and logs. Nothing newly printed to stdout that should not be. |
| **Test effectiveness** | Break the implementation on purpose — does the new test actually go red? Is the sample larger than the threshold it claims to test? Does the fixture have enough rows to test "every row"? |

How to run the pass:

- **Verify before reporting.** Try to disprove each finding first — construct the
  input or state that triggers it. A plausible finding that cannot be reproduced is
  noise, and noise teaches people to skip reviews.
- **Rank by severity**, most severe first. State the concrete failure:
  inputs or state → wrong behaviour.
- **Fix it or log it, never drop it silently.** Anything left unfixed goes in the
  mistakes log or an issue, with the reason.
- **Do not call a change set done while a confirmed correctness finding is open.**

In Claude Code, `/code-review` runs this pass; the lenses above are what to point
it at in this repository.

### Handing off the change set

**Leave the work uncommitted.** Finish the implementation, get `pnpm verify`
green, then stop and report. Do not `git commit`, do not `git push`, do not
`git stash`, and never `git checkout --` a path that holds uncommitted work.

The reason is the review pass above: it is meant to run against a working tree
somebody can still change their mind about. Committing first does not make the
review impossible, but it turns every finding into a follow-up commit and makes
"this change set is not done yet" unrepresentable.

The person who dispatched the work commits it. If you believe a commit is
genuinely needed mid-task — say, to keep a risky refactor recoverable — say so in
your report and let them decide.

---

## Mistakes log

Append one line per trap hit: **symptom → cause → correct approach.**
Written for the humans *and* the agents who come next.

- 取消任务后会话永远卡在「执行中」，之后该话题所有消息都被拒 → 只 kill 了直接子进程，
  Agent 起的孙进程还握着引擎的 stdout，`close` 事件因此永不触发，`finally` 也就永不收尾 →
  POSIX 用 `detached: true` 让子进程自成进程组，`process.kill(-pid)` 杀整组，并在 5 秒后升级到 SIGKILL。
- 整个 Agent OS 进程毫无征兆退出 → 往子进程 stdin 写数据时没监听 `error`，
  引擎提前退出产生的 EPIPE 是未捕获异常，而所有 bot、会话、调度器都在同一个进程里 →
  每个 spawn 点在第一次写入之前先挂 `child.stdin.on("error", ...)`。
- 停止按钮报「任务已经结束」，但 CLI 还在改文件 → `activeRuns.set` 写成了覆盖而不是占位，
  两条紧邻的消息都通过准入检查后，后到的那条把仍在运行的记录顶掉了 →
  占位前先 `if (activeRuns.has(id)) throw`，让后到者在碰这个 Map 之前就退出。
- 派给审查 bot 的任务凭空消失，重派也没反应 → 交接单在「领取即删除」之后、真正开跑之前
  就经过了若干可能提前返回或抛错的分支，去重键也已经烧掉 →
  用 `try/finally` + `dispatched` 标志，没开跑就把交接单退回收件箱并释放去重键。
- 同一话题里第二项任务的审查从来不发生 → 去重键只有 `taskId:round:toBotId`，
  同话题两项任务派给同一个审查 bot 时键相同，第二次被当成重复消息丢弃 →
  键里必须带 `dispatchId`，它才唯一标识「这一次投递」。
- 手工编辑 `data/schedules.json` 不再生效，而且改动过一会儿就被覆盖回去 →
  持久化用 tmp + rename，rename 换掉了 inode，老的 `fs.watch` 跟着失效；内存快照随后又把旧值写回磁盘 →
  每次自己写盘后重新挂 watcher。
- 一条 cron 写错（比如 `0 9 * * MON`）之后整条定时任务从磁盘上消失 →
  `reload()` 丢掉校验失败的行，下一次写盘就把它从文件里抹掉了 →
  解析失败的原始行要留在 `unparsedRows` 里一起写回，只是不参与调度。
- 卡片显示「暂时无需整理」，但上下文其实已经压缩过 → 用 `message` 是否为空来判断有没有压缩，
  而 Codex 分支会在压缩成功时也带回一条提示 → 用 `compacted` 布尔值判断，`message` 只作补充说明。
- Windows 上应用工具从来挂不上 → `--mcp-config` 的 JSON 直接进了 argv，
  `shell: true` 下 cmd 不转义参数，整段 JSON 被空格拆碎 →
  写成临时文件传路径（该参数同时接受文件与字符串）。
- 回归测试通过，但线上照旧复现 → 测试用 `writeFileSync` 就地覆盖来模拟「用户手工编辑」，
  而真实编辑器（vim / VS Code / JetBrains / sed -i / mv）走的是 tmp + rename，会换掉 inode →
  **模拟外部行为时要模拟它真实的系统调用**，不是它看起来的效果；
  新写的回归测试必须先撤销修复确认它会红，否则它只是在给你发假安全感。
- SIGKILL 升级永远不触发 → 判据用了 `child.exitCode === null && child.signalCode === null`，
  而直接子进程收到 SIGTERM 后立刻退出，这两个字段马上非空；真正赖着不走的是孙进程 →
  升级判据要探测**进程组**（`process.kill(-pid, 0)`），不是直接子进程的状态。
- 派出去的任务偶尔凭空消失 → 调用方在 `void runCliTurn(...)` 之前就把「已接手」置位，
  而 runCliTurn 在启动 CLI 前还有占位冲突、状态落盘失败、卡片发送失败三条退出路径 →
  「是否真的开跑」只能由 task-runner 通过 `onStarted` 回调告诉调用方，调用方不能自己猜。
- 成功的任务被报告成失败，团队交接还断了 → 只给终态卡片加了「刷新失败不改写结果」的豁免，
  紧跟其后的长答案续发和兜底回复仍然裸奔在 try 块里 →
  **展示层的每一个出口都要不可抛**，不能只保护其中一个。
- 结论「已送达」但 CLI 从没收到 → 先删流程再续跑，续跑失败时已经没有任何东西持有它 →
  一律「先送达再销毁」；送不达就退回可重试状态，并把卡片改回带按钮的形态。
- 一个瞬时 529 抹掉半小时工作 → runCli 把任何非零退出都当终局，而上游（模型服务、网络）
  的 5xx / Overloaded / socket hang up 是临时的，真机一天撞到两次，
  每次都作废一个已完成四十多次工具调用的实现任务 →
  可识别的瞬时故障要有界重试（3 次），**重试必须带上已经拿到的 CLI 会话 id 续接**，
  不然上下文白扔等于从头再来。超时和用户取消不在此列——那两种重试只会浪费更多时间。
- 自动审查环路让 bot 基于一个错误前提加了一段死代码 →
  Codex 提意见、developer 照做，两边都没拿真实行为验证过「post 消息里 at 是裸 open_id」这个前提；
  真机日志里它其实是 @_user_N 占位符 →
  **审查意见也是待验证的假设**。涉及外部协议行为的结论，落地前要有一条真机取证或一个用例撑着。
- 抄了一个正确写法的「形状」，却把关键顺序改掉了 → 追加操作照搬了 schedule 的
  `mutate()` 外形，但把变更挪到了写队列**外面**，回滚也从「还原整份快照」改成「按 id 删」。
  两处都致命：队列外的变更根本没被串行（persist 序列化的是它执行那一刻的内存，不是排队时的快照）；
  满容量时 slice 已经挤掉最老一条，按 id 删补不回来 →
  **变更必须整体在队列内部做，失败还原整份快照**。抄模式时要抄不变量，不是抄形状。
- 靠匹配错误文案判断错误类型 → 超时消息一拆成「空闲」「总时长」两句，
  `includes("执行超时")` 就悄悄失效了，最常见的那条反而走不到新加的提示 →
  **错误类型用具名标记（`error.name`）判断，永远不要匹配文案**。
- 飞书群里发 `/resume`，列表里出现了人在终端里开的、和这个 bot 完全无关的会话 →
  `native-sessions` 只按 cwd 过滤，而 bot 的 workspace 往往就是人自己干活的目录；
  群里任何人都能把它恢复出来继续跑，引擎还带着无人值守参数 →
  默认只列 Agent OS 自己派发的（首条提示词带角色前缀），想要全量要显式配 `resumeScope: "workspace"`。
  **列表和按钮回调两处都要过滤**——只在列表里藏起来，按钮里塞个 id 照样能恢复。
- 应用工具分支在日志里完全隐形 → 澄清、审批、产品方案、定时任务这些分支都在
  `[CLI] 完成` 之前就 return，一句日志都不打，联调时只能看到「会话建了、会话空闲了」，
  中间发生了什么全靠猜 → **每一条提前返回的分支都要留痕**，它们恰恰是系统里最重要的状态转移。
- 文档里的 `pnpm deploy` 跑不起来 → pnpm 10 自带 `deploy` 子命令，会把同名脚本吃掉
  （`ERR_PNPM_NOTHING_TO_DEPLOY`）→ 自定义脚本名要避开包管理器的内置命令；
  **写进文档的命令必须真的执行一遍**。
- 定时任务文件是外部创建的，热更新永远收不到 → 启动时文件不存在，`fs.watch(文件)` 抛 ENOENT，
  watcher 压根没挂上，而兜底逻辑写的是「第一次写盘后再挂」，外部创建的文件等不到那一刻 →
  **监听目录而不是文件**：文件不存在也能监听，rename 换 inode 时目录 inode 也不变，
  连「写完要重挂」那套机制一起省掉了。
- 手写进 schedules.json 的任务被静默丢弃 → `z.iso.datetime()` 默认只收 UTC 的 Z 后缀，
  手写 `+08:00` 直接判非法 → **给人编辑的文件要按人的写法校验**（`{ offset: true }`），
  并且拒绝时要报出是哪一条、哪个字段，只打一坨 Zod JSON 等于没报。
- 停掉 Agent OS 之后，引擎还在改文件，改动没人看得见 →
  spawnCli 用了 `detached: true`（取消时要杀整棵进程树），代价是引擎不随父进程退出；
  而关闭时只停了调度器，没有中止 activeRuns，`pkill` 默认发的 SIGTERM 也没有处理器 →
  **关闭必须主动 abort 所有运行中的任务**，SIGINT 和 SIGTERM 都要接。
- 中文任务被当成空消息挡掉 → 用 `/@\S+/` 剥离 @提及，而中文里「@agent-os读一下」
  中间不打空格，`\S+` 一路吃到句尾 →
  剥离要按 mentions 精确匹配（text 消息是 `@_user_N` 占位符，post 消息渲染后是 open_id），
  **凡是「用正则猜结构」的地方，都要先问结构本身是不是已经拿到了**。
- 往 README 加一行时间戳的小任务，两台 bot 来回弹了十几轮 →
  `collaborationMaxRounds` 被当成「防失控安全阀」设成 16，但 continueCollaboration
  只要 `round < maxRounds` 就无条件回弹，没有任何别的终止条件 →
  **在自动互审（reviewBy）下，这个上限等于「必须跑满的往返次数」，不是安全阀**。
  开发↔审查这一对填 2；只有 dispatch_task 那种由模型决定下一步的场景，它才是真正的安全阀。
- 任务照常执行，交接单却被退回，等于同一件事做了两遍 → 用 `void runCliTurn(...)` 之后紧跟
  `finally`，而「已接手」是异步回调置位的：finally 先跑，回调后到 →
  **异步信号不能用同步 finally 去读**。要么 `await` 那个信号本身
  （`Promise.race([startedSignal, settled])`，只等接手不等跑完），要么把补偿放进回调链里。
- 为验证「新测试会不会红」而故意改坏实现，收尾时 `git checkout -- src/` 一把把票据本身的
  改动也清光了 → 待验证的实现**本来就是未提交状态**，`git checkout` 的还原目标是上一次提交，
  不是「破坏之前」→ **破坏前先 `cp` 一份原始文件，恢复用 `cp` 回来，不要用 git 命令**。
  动手前额外 `git diff > /tmp/x.patch` 存一份，收尾后 `diff` 一下确认逐字节一致。
- 历史的「成功」档里躺着一条其实卡在用户审批上、根本没做完的任务 → 状态模型把
  「做完后把结果流转出去」和「停下来等人拍板」压进了 `handoff` 一个取值，
  按状态分档的视图只能整档收下或整档排除，怎么分都错一半 →
  **一个取值只能有一种含义**：拆成 `forwarded` 与 `waiting`，
  老记录保留原值并在卡片上标成旧记录——两种含义在记录里没有任何字段能分开，
  改写它等于替用户猜一半历史的结局。
- 详情卡把落盘的答案原样渲染，改成 900 字预览后 207 项测试**全绿** → 用例里最长的答案样本
  只有 112 字，而展示层的预览阈值是 900 字：**样本比阈值小一个数量级，断言再多也测不出截断**。
  凡是「不能被截断 / 不能被省略 / 不能超长」这类性质，样本必须**跨过那个阈值**，
  并在尾部放一个唯一哨兵串，断言哨兵还在。同理，「每一行都有 X」要在**行数足够多**的那一页上验，
  拿只有 1 行的页面去比「按钮数 == 行数」，等于拿 1 比 1。
- 把 `handoff` 拆成 `forwarded` / `waiting` 是为了让「停下来等人」不再冒充「做完了」，
  结果只改了历史筛选这一个消费方，调度器那边 `outcome === "failed" ? ... : "success"`
  照旧把 `waiting` 吞进「成功」→ 同一轮执行，`/history` 说「等待确认」，`/schedule` 说「成功」。
  **改一个取值的含义，要把它的每一个消费方都找出来**（`grep` 那个类型名和那个变量名，
  不是只 grep 字面量），并且把这类分派写成穷举的 `switch` 而不是三元链或 `else` 兜底——
  兜底会让下一个新增取值继续默默归进某一档，穷举会让 TypeScript 当场报错。
- 用户在真机上发 `/history` 毫无反应，日志里原文是 `@agent-os/ history` → 两处叠加：
  @提及后面没打空格，中文输入法又在斜杠后自动补了个空格（同一条消息里
  `package.json` 也被打成了 `package. json`）。命令没匹配上，就被当成普通任务派给了引擎。
  错题本上面那条「凡是用正则猜结构的地方，先问结构本身是不是已经拿到了」当时只修了
  任务路径，**命令解析这条路照旧在用 `@.+?\s+` 猜提及边界** →
  **同一条教训要把它的每一条使用路径都改完**，只修触发它的那一处，剩下的会在别处再咬一次。
  顺带：面向人的输入要容忍输入法的空格，`/ history` 必须和 `/history` 等价。
- 给「可能永不返回」的调用加超时护栏，用了 `setTimeout(...).unref()` → 护栏要生效的场景
  恰恰是**所有事都挂在这个调用上、事件循环已经空了**，而 unref 的计时器在空循环里
  不但不触发，还会让 Node 直接退出进程 → **超时计时器绝不能 unref**；
  正确做法是让它正常持有事件循环，竞速一结束就 `clearTimeout`。
  （这条是新写的测试当场逮出来的：一个永不结算的 Promise 让 `pnpm check` 挂死在
  「Detected unsettled top-level await」——护栏本身是坏的。）
- 断言「群里的机器人只收得到 @ 了它的消息」，让用户按这个前提去用 → 真机一测，
  不带 @ 的 `/status` **三台 bot 全都收到了**。前提错了，而且错得有代价：
  没有「点名」这道门时，群里一句普通任务会让每台 bot 各起一个 CLI，
  **在同一个工作目录里并发改同一个仓库**。
  错题本上面那条「涉及外部协议行为的结论不要凭推测下判断，要么找到真机取证，
  要么写用例撑着」——这次犯的正是它，而且是在**给用户下结论**的场合犯的，
  比写错代码更糟：代码有测试兜，说给人听的话没有。
- 给卡片按钮写「停用/启用」，回调侧用 `!当前值` 取反 → 群里同时存在两张 `/schedule`
  卡片是常态（发两次就有两张，`update_multi` 只同步同一条消息的观众、不跨消息），
  在旧卡上点那个写着「停用」的按钮，取反之后干的是**启用** →
  **按钮要把目标状态带回去，回调侧直接写这个值**，操作才是幂等的、才和按钮上的字一致。
  更要命的是我给它写的测试：拿同一份 payload 连点两次、断言 `false → true`——
  **等于把「同一个『停用』按钮第二次会启用」写成了通过断言**。
  凡是断言「重复同一个操作会得到不同结果」，先问这个操作本该不该幂等。
- 作用域校验没过，却仍然回了一张「刷新后的列表卡」→ 卡片可能正躺在别的群里，
  那一刷就把本群的任务名、cron、上次错误送了过去 → **拒绝就是拒绝，只回 toast，不带任何内容**。
  同一个文件里 `rejectForeignHistoryScope` 早就是这个规矩，新写的分支没跟上——
  **同一份代码里已有的安全惯例，新分支要照着抄，不要另起一套**。
- 交接轮里弹出的澄清卡，用户点开是「只有任务发起人可以回答」，谁都答不了 →
  `ownerOpenId` 一个字段扛了两个含义：**谁发起了这一轮**（交接来的是那台派活的 bot，
  写进历史很有用）和**谁有资格拍板**（必须是人）。交接轮里两者冲突，
  于是澄清卡、审批门、产品方案卡、以及「停止」按钮**四处一起锁死在一台 bot 身上**，
  任务永远停在那儿 → 拆成 `ownerOpenId` 与 `decisionOwnerOpenId` 两个字段。
  这和上面 `handoff` 拆成 `forwarded` / `waiting` 是同一条教训的第二次出现：
  **一个值同时回答两个问题，迟早会遇到两个答案不一样的场合**。
  下次给字段起名时先问：它回答的是哪一个问题？还有没有别的问题在偷偷用它？
- 为「两处文案会飘」加了一条断言，断言的却是 `helpLines()` 等于 `COMMAND_DOCS`——
  两者在同一个文件里，一个是另一个的 `map()`，**它从头到尾没碰过 `/help` 的代码路径**。
  把 handler 改回硬编码一份清单（正是这次重构要防的事），测试照样绿 →
  **给「A 和 B 会不一致」加断言时，先问这条断言到底跨没跨过那道边界**。
  只在数据源这一侧自证，等于把守卫架在了没人会走的那扇门上。
  判断方法还是老的：把你要防的那个错误真的犯一次，看它红不红——
  这次三个审查视角各自独立发现了它，而我自己没发现。
- 委派条款写成「有 `Task` 工具的话就派给 subagent，没有就自己做两遍」→ 引擎那边这个工具
  叫 `Agent`，它照字面一读「我没有 Task 工具」，**直接走了我给的那个逃生口**，两遍都没做，
  而且是静悄悄地没做 → **给退路时要问：它会不会比正路更好走？**
  正确做法是不依赖某一个确切名字（并列写出两种叫法），并要求走退路时在报告里说明——
  让降级可见，而不是默默发生。
  连带一条量测教训：我当时 grep `"Task"` 得到 0 次，据此断定「引擎没有这个工具」，
  **用错名字去量，会得到一个理直气壮的错误答案**。后来直接跑一次 headless 探针才看清
  工具清单里 26 个工具、`Agent` 赫然在列。**拿不准就实测，别用一次 grep 下结论。**
- 「删除定时任务要中止正在跑的那一轮」这个修复，测试全绿、审查却查出它只接通了两个入口里的一个：
  卡片按钮那条补上了，`schedule_manage` 工具那条原样缺失；而且标记挂在**一轮**上，
  审批拍板后的续跑、澄清答完的续跑、交接回来那轮全都丢掉它，删除时中止不到 →
  **修复自带的测试只覆盖了新写的那个纯函数，"全绿"因此不代表接线通了**。
  给一个修复写测试时，至少要有一条**跨过整条链路**：从用户真正会点的那个入口，
  到最终该发生的那件事。纯函数测得再全，也证明不了它被正确地接了上去。
  连带的结构教训：一个属性如果在多轮之间要保持（「这一轮属于哪条定时任务」），
  就该挂在**会话**上而不是挂在轮上——挂在轮上意味着每个 runCliTurn 调用点各挂一次，
  漏一个就是一个洞，而调用点会随着功能增加而变多。
- 成本按来源拆分时按「件」算，互审的开销全记到了「用户发起」头上 →
  一件用户发起的事，里面自动互审那几轮 origin 是 handoff，而整件事的 origin 是 user。
  **聚合的粒度要跟着「代价产生在哪一层」走，不是跟着「用户怎么理解它」走**：
  件数按件、开销按轮。真实数据里互审一度占总 token 的四分之三，
  按件算的话这个最该被看见的数字会完全消失。
- `/history` 改成按「一件事」列之后，详情按钮只指向最后一轮，**早期轮次在界面上全都够不着了**——
  真实数据里当场有 19 条记录变成不可达，而我加的测试全绿：它只验了「多轮归成一行」，
  没验「归组之后早期轮次还找得到吗」→ **把多个东西合并成一个展示单位时，
  先问被折进去的那些还有没有入口**。归组和展开是一件事的两半，只做前一半是把信息藏起来。
  这条和「断言要跨过它声称要守的那道边界」是同一个毛病的第三次出现。
- 给「一件事」加 token 预算，卡在发交接单那一步——测试却发现根本拦不住 →
  **发交接单发生在本轮记录落盘之前**，只查历史就看不到刚烧掉的这一轮，
  而失控往往正是从这一轮开始的 → **在写盘之前做的判断，拿不到本轮的数据，
  必须把它显式传进去**。凡是「检查 + 落盘」两件事，先想清楚谁在前。
- 识别「原地打转」时，别把「同一条命令重复很多次」直接当成卡住：
  测一遍、改一处、再测一遍是正经干活，tester 一轮跑十遍 `pnpm check` 完全正常。
  **区别在于中间有没有改过文件**——改了就是在推进。
  阈值取 6 而不是 3：**误报比漏报更坏**，一个总在喊狼来了的提示很快就没人看了。
  也只提示、不中止：中止一个其实在正常干活的任务，代价比多烧几分钟大得多。
- 判断「这一轮改没改过文件」时用了一张写文件工具的白名单（Edit / Write / …）→
  真机上引擎是用 `Bash` 跑 python 改的文件（一轮 6 次），一次 Edit 都没调；
  子 Agent 改的文件更是压根不出现在主轮次的事件流里。
  结果是 `editedFiles` 恒为 false，**「改了文件却没人验证」这个警告对一大类情况完全失效**，
  而且是静悄悄地失效 → **要判断「有没有发生某件事」，去看那件事的结果，别去数达成它的手段**。
  手段有的是白名单之外的写法，结果只有一个。
  改成前后各取一次工作区指纹（`git status --porcelain`）再比。
  连带一条：拿不到指纹时返回的是 **undefined（不知道）而不是 false（没改过）**——
  把「不知道」说成「没改过」，会让警告在最该响的时候沉默。
- 给飞书长连接开了两个 SDK 默认关着的开关，理由是「文档说开着更安全」，
  还写了测试钉住取值 → 真机四天，两个都被证伪：
  `handshakeTimeoutMs` 超时后 SDK 在定时器里调 `terminate()`，`ws` 抛的错没人接，
  **一路冒到顶把进程带走**（部署前 0 次崩溃，部署后 7 次，pm2 重启从 11 涨到 24）；
  `pingTimeout` 让重连率从 5.5 次/小时翻倍到 10.8 次/小时 →
  **读了文档不等于验证过**。文档说的是这个选项做什么，
  没说它出错时谁来接、也没说它在你这个网络上会多灵敏。
  外部组件的配置项属于「涉及外部协议行为」，同一条规矩：要么真机取证，要么别开。
  尤其讽刺的是，这个仓库最早的一条教训就是「未监听的 stream error 会带走整个单进程运行时」,
  `spawn-cli` 为此专门挂了 error 监听——我给 WebSocket 开了个会抛错的开关，却没给它挂。

- 新增目录准入后新话题卡在「创建中」 → 目录检查发生在 creating → active 之前，而统一收尾只处理 active → 启动失败也要允许 creating → idle，并验证目录恢复后同一话题可以重试。
- 停用 bot 的自定义凭证仍进入引擎环境 → 过滤名单只收启用的配置，把「不开连接」误当成「没有凭证」 → 过滤所有已配置的凭证变量名，停用只影响连接建立。
- 目录校验新增 await 后，任务已占位但状态仍 idle 时还能切目录 → 绑定命令只看会话状态，异步查询回来也不复查 → 同时检查 activeRuns，并在写入绑定前复查状态与原绑定，防止把 A 的 CLI 上下文写回 B 项目。
- 首轮定时任务删除后仍继续执行 → setScheduleId 返回新会话对象，调用方却把旧快照交给 runner → 使用带 scheduleId 的返回对象，并从真实 Scheduler 首次触发验证删除能中止执行。
- 评论授权测试全绿，却抓不住撤销主人访问权 → 样本只覆盖「有权限但不是主人」，从未让主人离开用户名单 → 身份归属、人员授权与群授权要分别构造拒绝场景。
- 转发恢复按钮的越权测试全绿，却抓不住删掉群校验 → 样本会话 ID 根本不存在，另一个拒绝出口冒充了安全守卫 → 断言越权请求在读取原群引擎历史之前就结束，或准备真实可恢复的历史样本。

- 交接卡片不能跨群点击，但取件通知仍能跨群重放 → 只保护了卡片入口，收件箱票据没有原群／原话题，自动交接还跳过负责人授权 → 票据绑定投递范围且校验后再删除，发送与领取两端都检查接收方负责人授权。
- 已确认的方案仍被排队评论修改 → 只在入队时找 pending 流程，把等待前的状态当成执行时的事实 → 实际执行前重新取当前流程，目录检查后再次检查终态，并覆盖等待期间确认、替换方案的回归。
- /resume 明明有自己派发的历史却显示空 → 先截取最近 8 条，再按来源过滤，终端历史把合法会话挤掉 → 来源过滤必须发生在限量之前，原生分页接口按游标继续取得合格条目。
- 用极大数测试日期范围，删掉日期校验测试仍绿 → 样本先被安全整数范围拒绝，根本没走到 Date 边界 → 用仍是安全整数、但超过 Date 支持范围的秒数，分别证明整数与日期守卫有效。
- 交接范围回归只测显式派发，自动返回丢字段仍全绿 → 三个调用点共用服务，却各自组装参数，只测一条链路不能证明其余接线 → 自动互审与自动返回也要从真实入口验证票据可被正确话题领取。

- DSH headless 加载时权限插件不激活 → 只把审批改成 never，原生 preset 仍组合 workspace-write + ask → 临时 patch 同时配置 sandbox、approval 和与它们匹配的 defaultPreset。
- DSH 少报一步用量却显示了看似完整的总消耗 → 把被截断的 step_end 整行忽略，只累加剩下的步骤 → 仍消费步骤结束，缺失的计数要标记不完整，不展示部分和。
- MCP 路径测试在 Windows 上误报挂载失败 → 用带正斜杠的字符串直接匹配 fileURLToPath 返回的原生路径 → 测试断言前统一路径分隔符。
- DSH 的子任务和 PTC 调用返回“已送达”，飞书却没有待办 → headless JSONL 只投影主会话普通工具调用 → 在原生 tools/result 最终结果上桥接完整参数，并校验调用方属于当前任务树。
- DSH 的 failOnStartupError 没拦住模型执行 → MCP 是可选插件，失败只记启动警告 → 把桥接就绪服务加到必需的 headless-runner 注入依赖，五个工具没齐就不启动任务。
- 首轮执行失败后“继续”重新开了上下文 → 原生标识只在成功 result 后才落盘 → 收到 session 立即串行保存，成功、失败和取消都等写入完成后再释放占位。
- 不同文件被报原地打转、真实验证却被标未验证 → 适配时丢了工具参数区别和原生 preset 身份 → 展示补详情，重复判据用完整参数指纹，验证角色只认已创建子任务的原生身份。
- CLI 已退出、绑定仍在写盘时点停止却继续派活 → 成功结算在等待写盘前就移除了取消监听 → 写盘完成后再次检查取消与超时，再结算成功。
- 多个子任务都收到“已提交”，飞书只显示最后一项 → 并行工具请求碰到了编排单轮只接一项的契约 → 原生守卫用不可伪造的执行 token 同步占位，成功保留、失败释放，其他调用明确拒绝；桥接另分配执行标识，不能靠模型 callId 去重。
- 工具已确认的问题在 529 续接成功后消失 → 重试只保留会话 id，丢掉失败尝试中已成功的应用请求 → 有界重试内保留带成功确认的请求，跨尝试加标识，取消和最终失败不交付缓存。
- 普通工具失败误删已确认的 MCP 请求 → 把原生 opaque callId 与桥接复合标识放进同一个命名空间 → 原生和桥接分别加来源前缀，桥接各组成字段用无歧义元组编码。
- 给缓存键加尝试序号的测试删了实现仍绿 → 只有一次失败加一次成功，第二项没经过缓存 Map → 用两次已确认后失败、第三次仅终态的样本跨过 Map 覆盖边界。
- DSH 已成功写入大文件却被判失败 → 把普通工具的有界 JSONL 展示截断当成应用参数损坏 → 普通工具只影响进度，应用请求走无损桥接，会话绑定和最终答案才要求无损。
- 停止已被接受，CLI 收尾却继续通知队友 → 取消信号只交给子进程，没覆盖应用层 await → 通知提交前逐次检查并撤回票据，提交边界同步关闭停止入口，不能承诺撤回已发出的请求。
- 预算提示说未派发，历史与卡片却报交接成功 → 忽略派发服务的 false 返回，而且终态先被绿卡关闭 → 三条交接路径都检查发送结果，确定结局后只提交一次终态卡。
- 评论里工具请求被空答案掩盖成「文档已更新」 → 评论入口只消费 answer → 澄清完整分段写回原评论并沿用会话，其他应用请求明确退回原话题，空终态不推断修改成功。
- 子任务与失败重试消耗没有计入预算 → headless JSONL 只投影根会话，Runner 重试又只返回最后一次统计 → 桥接当前任务树后代的原生结算，跨 CLI 尝试累计计数，任一采样缺失时不发布伪精确总量。
- 方案显示已确认后文档仍被评论任务改写 → 确认入口没检查同步占位与会话状态 → 准备和执行期间拒绝确认，结束并复查后再确认，不能只保护评论启动前。
- 用普通消息回答澄清，发卡失败后已答内容消失 → 准备续接时就删除旧流程 → 接续轮真正接手后才让旧卡失效，启动失败保留同一任务和已答内容。
- 评论花费 30 万，预算仍只看到原来 1 万 → 评论入口只续跑和回复，没有落任务历史 → 普通任务与评论共用收尾记录，沿用方案 taskId，并在释放占位前计入消耗。
- 失败或取消的任务消耗显示为零 → 失败通道只抛 Error，已观察统计被留在 Runner 内部；部分适配器还忽略错误终态 usage → 错误携带统计与会话标识，丢弃待派发请求，所有结局共用落盘口径。
- 配了总时长仍能跑三倍，或退避结束前多起一次空重试 → 每次尝试重置计时，退避计时又可能向下取整提前唤醒 → 整轮用单一截止时间，预算不够完成退避就直接超时，不能靠不足 1ms 的余量启动下一次。
- 常驻几天后 MCP 一直加载失败，重启才恢复 → 缓存只记临时文件路径，系统清理文件后仍返回旧路径 → 每次确认配置与桥接内容完整，缺失或损坏时用独立临时文件原子重建。
- 显式派活跑到 2/1、3/1 仍继续 → 轮次上限只挡自动返回 → 公共派发出口在发卡与登记票据前校验合法轮次，所有路径共用。
- /cd 报失败，/new 却把失败目录写回磁盘 → 只序列化写盘，后继命令提前读到未提交对象 → 读、校验、变更整体入队，保存成功后才发布快照；准备消息后再次核对绑定。
- 方案确认报错后内存已确认、重启又待确认 → 写盘失败没恢复流程对象，创建替代方案还提前过期旧卡 → 快照整个集合并原地恢复旧对象，保存失败不发送确认成功。
- 审批显示已送达但 CLI 从没启动，澄清答案也消失 → 把进度卡成功当作引擎接收 → 卡片与自然文字续接都等原生会话或执行事件后再销毁流程，缺标识、spawn 失败和无确认错误保留重试。
- Claude/Codex 已成功的 MCP 请求在 529 后消失 → 只识别 DSH 的完成标识 → 把匹配的原生成功 tool_end 也登记为确认，失败或仅开始的调用不进入跨重试缓存。
- CLI 输出 JSON null 带走整个服务 → JSON.parse 成功就强转对象，readline 回调异常也没边界 → 先用 Zod 校验事件封套，解析或回调异常只终止本轮且不作为上游瞬时错误重试。
- 解析异常或停止后新任务启动，旧孙进程仍在写文件 → 只等直接子进程 close，忽略 stdio 已重定向的后代 → 终止等待整组停止或强杀完成，状态落为 idle 后才删除运行占位。
