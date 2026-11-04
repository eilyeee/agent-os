# Agent OS

**中文说明：[README.zh-CN.md](./README.zh-CN.md)**

A command deck that turns Lark/Feishu into the control surface for headless AI
coding CLIs. One thread is one task. Bots hand work to each other. A scheduler
dispatches work while you sleep.

> **Status: experimental, self-hosted software for trusted users.**
> `pnpm verify` checks pure logic and orchestration through a fake Lark. Real
> credentials, a topic group and installed engines are needed for end-to-end
> acceptance. Follow the [deployment guide](./docs/deployment.md) before granting
> a bot access to your machine.

---

## What it is

Models keep getting stronger, but the way we use them has not changed much: you
sit at a terminal, copy context between windows, chase progress, hand results
around by hand. The capability is there. What is missing is an operating layer
that lets those agents work over long stretches of time.

Agent OS is that layer.

```
      human entry                automated entry
  Lark threads · cards · docs   schedules · patrols · alerts
            \                        /
             \                      /
        ┌───────────────────────────────┐
        │        Agent OS kernel        │
        │  tasks · sessions · agents    │
        │  permissions · workdirs       │
        └───────────────────────────────┘
                       │
        ┌───────────────┴───────────────┐
        │  execution engines (headless) │
        │   Claude Code    ·    Codex   │
        └───────────────────────────────┘
```

**It does not call model APIs.** There is no AI SDK dependency. Model calls, tool
execution and context management stay inside Claude Code, Codex and DeepSeek Harness. Agent OS
commands them — and the engines underneath can be swapped later without losing
the way of working built on top.

### What it is not

- Not a chatbot wrapper. Wrapping a CLI in a chat window gets you a nicer chat
  window; the interesting problems are memory, verification, permission and dispatch.
- Not a hosted service. It runs on your own machine over a WebSocket long
  connection — no public IP, no domain, no TLS certificate, no webhook endpoint.
- Not a model provider. Bring your own Claude Code / Codex login (or point them at
  a compatible endpoint).

---

## Capabilities

**Solo mode** — command one agent from anywhere

- Ask from a Lark thread, a real Claude Code, Codex or DSH process does the work
- Live task card: current action, tool trail, elapsed time, context usage, cost
- Stop a running task from the card; only the person who started it can
- Follow-up questions in the same thread resume the same CLI context
- Per-thread working directory, so one bot can serve several projects
- `/new`, `/resume`, `/compact` reuse each engine's **native** session handling —
  only sessions dispatched by Agent OS appear by default. Terminal sessions
  require explicitly setting `resumeScope: "workspace"`

**Team mode** — let a group of agents run itself

- Several bots in one group, each with its own credentials, role and default engine
- Explicit handoff with `dispatch_task`, capped by a round limit and token budget;
  the round limit applies to explicit dispatches and automatic returns alike
- Code review and tests run inside the developer CLI as sub-agents when the engine
  supports them. Automatic cross-bot review with `reviewBy` is optional and off
  in the example configurations
- Structured clarification: the product manager asks via a Lark form instead of prose
- Product specs land as local Markdown **or** a Lark cloud doc — one authoritative
  artifact, never two out of sync
- Review a spec by commenting in the cloud doc and @-mentioning the product manager

Clarification questions and all options are posted back to the original comment.
Reply there and @-mention the bot to continue the same session. Approval, handoff
and scheduling requests must be started in the original Lark thread; comments
cannot approve operations. The existing spec confirmation card stays valid.

Comment runs count toward the original spec's task history and budget. A spec
cannot be confirmed while its session is preparing or editing. Failed and
cancelled turns retain usage reported by the engine; unreported counters remain
unknown.

Stopping before a teammate notification is submitted removes the undelivered
handoff. Once a notification or application result starts committing, the stop
button explains that it cannot be withdrawn. Budget refusal is recorded as a
failure with a reason, never as a successful handoff.

The total runtime limit covers all attempts and retry delays; stopping also works
during backoff. Missing or damaged temporary MCP configs and DSH bridge files are
regenerated before the next tool-chain launch.

Clarification answers and approval decisions remain available to retry if the
engine fails to accept the continuation. Confirmed application requests survive
transient CLI retries. Failed session or spec writes preserve the last committed
state; concurrent directory changes cannot leak into another command.

Malformed CLI JSON is ignored. Parser or event-handler failures end the affected
turn, and cancellation waits for the CLI process tree to stop before releasing
the session.

**Proactive mode** — work that starts without you

- Schedule tasks in plain language with `/schedule`; a trigger opens a thread and
  dispatches work, and the card lets you pause, resume or delete a job
- Log patrols that stay quiet when healthy and escalate when they are not
- Approval workflow: an agent calls `request_approval`, ends its turn, and resumes
  after a human decides on the card. This depends on the engine following the
  instructions; it does not intercept arbitrary commands

---

## Requirements

| | |
|---|---|
| Runtime | Node.js 22.13+, pnpm 11.5.3 |
| Chat | A Lark/Feishu **topic group** (not a regular group) and a self-built app per bot |
| Engines | [Claude Code](https://docs.claude.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex), or [DeepSeek Harness](#deepseek-harness-experimental), installed and configured |
| OS | macOS, Linux, or Windows via Git Bash / WSL2 |

Install and authenticate your chosen engine under a dedicated operating-system
account. Engine credentials and model configuration belong to that CLI's user-level
configuration. Agent OS does not provide model access or manage billing.

---

## Quick start

```bash
git clone https://github.com/eilyeee/agent-os.git
cd agent-os
pnpm install --frozen-lockfile

cp .env.example .env
cp config/bots.example.json config/bots.json

# Fill in credentials, replace ownerOpenId and set an existing trusted workspace.
# Complete the Feishu application setup in docs/deployment.md before starting.
pnpm start:once
```

The default configuration enables one developer bot and local artifact delivery.
Keep its workspace separate from this repository and its `.env`. Complete the
[Feishu application setup](./docs/deployment.md#飞书应用设置), then start a thread
in your topic group and mention the bot:

```
@developer  Read package.json and summarise how this project boots
```

A task card appears in the thread, refreshes while the CLI works, and turns green
with the answer. Ask again in the same thread and the context carries over.

---

## Configuration

**`.env`** — secrets only, never committed.

```dotenv
BOTS_CONFIG=config/bots.json

FEISHU_DEVELOPER_APP_ID=cli_xxx
FEISHU_DEVELOPER_APP_SECRET=xxx
```

**`config/bots.json`** — roster, roles, engines, workspaces. Stores *variable
names*, not credential values.

```jsonc
{
  "teamLeader": "developer",
  "defaultProductDeliveryMode": "local",
  "bots": [
    {
      "id": "developer",
      "appIdEnv": "FEISHU_DEVELOPER_APP_ID",
      "appSecretEnv": "FEISHU_DEVELOPER_APP_SECRET",
      "defaultCli": "claude",
      "workspace": "../my-project",
      "ownerOpenId": "ou_replace_me",
      "role": "Developer — implements, then runs review and tests",
      "skills": [],
      "resumeScope": "agent-os",
      "collaborationMaxRounds": 2
    }
  ]
}
```

Replace `ownerOpenId` with your ID as seen by this application. Without
`allowedUserOpenIds`, only that owner is allowed; without either, human requests
are denied. Add `allowedChatIds` to restrict chats and `allowedWorkspaceDirs` to
allow additional working directories. See the [access settings](./docs/deployment.md#访问权限与工作目录).

For a three-bot team, start from
[`config/bots.team.example.json`](./config/bots.team.example.json). Each bot needs
its own application credentials and owner ID. Optional skills and cloud documents
require the extra setup in the deployment guide. Disable a bot with
`"enabled": false`; it will not ask for credentials or open a connection.

---

## Commands

Available to allowed users and chats. In a group, Feishu delivers your message to *every* bot in
it, mention or not — so who acts is decided by addressing: @ a bot and only it
responds; @ nobody and only the Team Leader does. In a direct chat there is
nothing to address; the same access checks still apply.

| Command | Effect |
|---|---|
| `/help` | List available commands |
| `/status` | Bot, session, engine, CLI session id, working directory |
| `/history` | Tasks this bot ran in this chat, across threads — filter by outcome, page through them |
| `/cost` | What this bot has spent in this chat: tokens, split by origin, priciest items |
| `/team` | Team roster: roles, engines, skills, connection state |
| `/new` | Start a fresh CLI session in this thread |
| `/resume` | Pick a historical CLI session from this working directory |
| `/compact [note]` | Have the engine natively compress its own context |
| `/cd [dir]` | Show or change this thread's working directory |
| `/schedule [sentence]` | List this bot's cron jobs, or create/adjust one in plain language |
| `/close` | Stop any running task and close this thread's session |
| `/claude <task>` | Start a new thread on Claude Code |
| `/codex <task>` | Start a new thread on Codex |
| `/dsh <task>` | Start a new thread on DeepSeek Harness |

An engine is fixed when a thread is created — switching means opening a new thread,
because the CLIs' session ids are not interchangeable.

### DeepSeek Harness (experimental)

The adapter targets official `@deepseek-ai/dsh@0.2.1-rc.5`. Use Node.js 24.9+ for DSH and make that `dsh` available on Agent OS's `PATH`. Older DSH versions lack the required JSON stream and persisted-session resume support.

```bash
npm install -g @deepseek-ai/dsh@0.2.1-rc.5
dsh --profile headless --help
```

Configure models and credentials in DSH's user directory (`~/.dsh/.env` by default, or `$DSH_HOME/.env`) following the [official headless documentation](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/bundle/headless/README.md). Keep them out of this repository's `.env` and bot JSON. Send `/dsh <task>` in a new thread, or set `defaultCli` to `"dsh"`.

Supports task execution, automatic continuation in the same thread, tool progress, usage totals, and all five MCP application tools. Agent OS writes a temporary MCP patch and native event bridge without changing DSH's user configuration or adding a model API dependency. All five tools must register before the headless task starts; MCP or bridge startup failures block execution. Application-tool results from child agents and PTC programs reach the same thread; human answers resume the main session. One CLI execution accepts one successful application request; additional concurrent requests receive an explicit error and can be submitted after the current request is handled. DSH runs with `workspace-write` and denies operations requiring interactive escalation; approval in Lark does not bypass that sandbox.

Usage includes the main task, descendant agents and sampled failed attempts,
including CLI retries. Missing counters stay unknown rather than publishing a
partial sum as an exact total. Truncated progress arguments from ordinary tools
do not make a successful execution fail; application requests still use the
lossless bridge.

The headless interface currently exposes neither a session list nor native command routing, so the `/resume` picker and manual `/compact` are unavailable. Existing threads continue automatically; DSH owns automatic compaction, and `/new` starts fresh context. Application requests use lossless native final tool results instead of truncated JSONL notifications. Native session bindings survive first-turn failures and cancellation. Verification markers use the actual created child preset identity (`tester` / `code-reviewer`), never free-form descriptions. After configuring DSH, run `pnpm probe:tool dsh /absolute/workspace` in a trusted test workspace to verify MCP end to end.

---

## Architecture

```
src/im/     Lark ingress    long connection, event parsing, card construction
src/core/   kernel          sessions, state machine, persistence, collaboration
src/cli/    engines         per-CLI arguments and protocol → unified CliEvent
src/app/    orchestration   how a message flows through the system
src/mcp/    tools           local MCP server exposing app tools to each CLI
```

The kernel does not depend on any messaging platform. Engine differences are
compressed into three adapter methods — `buildArgs`, `buildResumeArgs`,
`parseEvents` — so adding a third CLI means adding one file, not a second pipeline.

Layer rules, conventions and the traps worth knowing about live in
[`AGENTS.md`](./AGENTS.md).

---

## Roadmap

| | Milestone | Delivers | State |
|---|---|---|---|
| M0 | Scaffold + CLI reconnaissance | Project skeleton, event-stream probe | built |
| M1 | Lark ingress | Long connection, mentions, media, live cards | built |
| M2 | Session kernel | State machine, crash-safe persistence | built |
| M3 | Execution engines | Claude Code + Codex, streaming cards, stop button | built |
| M4 | Multi-bot + collaboration | Per-bot sessions, working dirs, review handoff | built |
| M5 | Agent team + refactor | Team registry, `/team`, orchestration layer | built |
| M6 | MCP tools + product flow | Clarification forms, specs, approvals, cloud docs | built |
| M7 | Proactive agents | Scheduler, cron, approval gate | built |
| M8 | Deployment | pm2 config, restart recovery | built |

`pnpm verify` runs the local verification suites. `check` covers pure logic
(schemas, state machines, persistence, migrations, cron, event parsing, card
rendering) and `integration` drives the real orchestration through a fake Lark
(command dispatch, card callbacks, clarification and approval flows, ownership
checks, session routing). Two layers stay uncovered: the Lark long connection and
the CLI subprocesses. Those need real credentials and a real topic group, so no
milestone is marked accepted until the [deployment checklist](./docs/deployment.md#真实环境验收)
passes there.

---

## Safety

Running headless inside a chat app means there is no interactive permission
prompt, so the engines are launched with `--dangerously-skip-permissions` /
`--yolo` (Windows Codex uses the equivalent bypass flag). These flags grant the
engine the permissions of its operating-system account.

- Run under a dedicated low-privilege account or an isolated container; keep only
  the credentials and files the task actually needs in that environment
- Allow only trusted people and chats. Authorized members share the bot account
  and its accessible CLI context; this is not a multi-tenant service
- Keep workspaces separate from the Agent OS directory containing `.env` and `data/`,
  and keep a recoverable baseline before allowing edits
- `allowedWorkspaceDirs` limits the working directory chosen by Agent OS, including
  symlink resolution. It does not restrict the files a CLI tool can read or write
- Approval cards are a cooperative workflow. An engine that ignores instructions
  can execute a command without calling `request_approval`; use operating-system
  isolation for enforceable boundaries
- Message ingress logs omit message bodies. Task history and native CLI history
  still contain prompts and answers; protect `data/` and the engine account's history

## Running it as a service

```bash
npm i -g pm2
pnpm pm2:start       # build + pm2 startOrReload ecosystem.config.cjs
pm2 save             # remember the process list
pm2 startup          # print the command to run (needs sudo) so it survives a reboot
pnpm pm2:logs        # tail
```

Single instance only — sessions, the collaboration inbox and the scheduler all live in
process memory, so a second instance would keep its own copy of all three.

---

## License

[MIT](./LICENSE). Bundled third-party skill notices are in
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
