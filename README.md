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
execution and context management stay inside Claude Code and Codex. Agent OS
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

- Ask from a Lark thread, a real Claude Code or Codex process does the work
- Live task card: current action, tool trail, elapsed time, context usage, cost
- Stop a running task from the card; only the person who started it can
- Follow-up questions in the same thread resume the same CLI context
- Per-thread working directory, so one bot can serve several projects
- `/new`, `/resume`, `/compact` reuse each engine's **native** session handling —
  only sessions dispatched by Agent OS appear by default. Terminal sessions
  require explicitly setting `resumeScope: "workspace"`

**Team mode** — let a group of agents run itself

- Several bots in one group, each with its own credentials, role and default engine
- Explicit handoff with `dispatch_task`, capped by a round limit and token budget
- Code review and tests run inside the developer CLI as sub-agents when the engine
  supports them. Automatic cross-bot review with `reviewBy` is optional and off
  in the example configurations
- Structured clarification: the product manager asks via a Lark form instead of prose
- Product specs land as local Markdown **or** a Lark cloud doc — one authoritative
  artifact, never two out of sync
- Review a spec by commenting in the cloud doc and @-mentioning the product manager

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
| Engines | [Claude Code](https://docs.claude.com/en/docs/claude-code) and/or [Codex CLI](https://github.com/openai/codex), installed and logged in |
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
| `/new` | Start a fresh CLI session in this thread; old one stays recoverable |
| `/resume` | Pick a historical CLI session from this working directory |
| `/compact [note]` | Have the engine natively compress its own context |
| `/cd [dir]` | Show or change this thread's working directory |
| `/schedule [sentence]` | List this bot's cron jobs, or create/adjust one in plain language |
| `/close` | Stop any running task and close this thread's session |
| `/claude <task>` | Start a new thread on Claude Code |
| `/codex <task>` | Start a new thread on Codex |

An engine is fixed when a thread is created — switching means opening a new thread,
because the two CLIs' session ids are not interchangeable.

---

## Architecture

```
src/im/     Lark ingress    long connection, event parsing, card construction
src/core/   kernel          sessions, state machine, persistence, collaboration
src/cli/    engines         per-CLI arguments and protocol → unified CliEvent
src/app/    orchestration   how a message flows through the system
src/mcp/    tools           local MCP server exposing app tools to both CLIs
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
