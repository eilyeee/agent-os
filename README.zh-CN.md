# Agent OS

**English: [README.md](./README.md)**

把飞书变成 headless AI 编程 CLI 的指挥台。一个话题就是一个任务，bot 之间互相交接，
定时器在你睡觉时自己派活。

> **当前状态：实验性自托管软件，面向受信任的使用者。**
> `pnpm verify` 覆盖纯逻辑和假飞书驱动的编排链路。
> 飞书长连接及真实 CLI 需要凭证、话题群和已安装的引擎才能验收。
> 在授权机器人操作本机之前，请先完成[部署指南](./docs/deployment.md)。

---

## 这是什么

模型越来越强，我们每天使用它的方式却没怎么变：守在终端前，在几个窗口之间复制上下文，
追问进度，手动转交结果。能力已经到位，缺的是一套能承载它们长期工作的操作层。

Agent OS 就是这一层。

```
        人的入口                    自动化入口
   飞书话题 · 卡片 · 云文档      定时任务 · 巡检 · 告警
            \                        /
             \                      /
        ┌───────────────────────────────┐
        │        Agent OS 系统内核       │
        │   任务 · 会话 · Agent          │
        │   权限 · 工作目录 · 调度        │
        └───────────────────────────────┘
                       │
        ┌───────────────┴───────────────┐
        │      执行引擎（headless）      │
        │   Claude Code   ·   Codex     │
        └───────────────────────────────┘
```

**它不调模型 API。** 项目里没有任何 AI SDK 依赖。模型调用、工具执行、上下文管理都留在
Claude Code、Codex 和 DeepSeek Harness 内部，Agent OS 只负责指挥它们 —— 底层引擎以后可以换，
上层建立起来的工作方式会一直留下来。

### 它不是什么

- **不是聊天机器人套壳。** 把 CLI 包进聊天窗口，得到的只是一个更好用的聊天窗口；
  真正有意思的问题是记忆、验证、权限和分发。
- **不是托管服务。** 它跑在你自己的电脑上，走 WebSocket 长连接 ——
  不需要公网 IP、域名、TLS 证书，也不需要 webhook 回调地址。
- **不是模型服务商。** 自带 Claude Code / Codex 登录态（或让它们指向兼容端点）。

---

## 能做什么

**单兵作战 —— 随时随地指挥一个 Agent**

- 在飞书话题里提要求，真实的 Claude Code、Codex 或 DSH 进程接活
- 实时任务卡片：当前动作、工具轨迹、耗时、上下文占用、成本
- 卡片上一键停止任务，且只有发起人点得动
- 同话题追问续接同一段 CLI 上下文
- 每个话题有自己的工作目录，一台 bot 可以同时服务多个项目
- `/new`、`/resume`、`/compact` 复用引擎**原生**的会话能力 ——
  默认只列出 Agent OS 派发的会话；终端会话需要显式设置 `resumeScope: "workspace"`

**团队作战 —— 让一队 Agent 自己转起来**

- 一个群里多台 bot，各有独立凭证、角色和默认引擎
- 通过 `dispatch_task` 显式交接，由轮次上限和 token 预算限制续跑；显式派活与自动返回都遵守轮次上限
- 代码审查与测试在开发者 CLI 内部使用子 Agent（需要引擎支持）；`reviewBy` 自动跨 bot 审查可选，示例默认关闭
- 结构化澄清：产品经理用飞书表单提问，而不是甩一大段文字
- 产品方案落地为本地 Markdown **或**飞书云文档 —— 唯一权威产物，不做双份同步
- 直接在云文档评论里 @产品经理 完成评审，它会改正文并在原评论下回复

评论评审需要澄清时，问题与选项会完整写回原评论；在同一评论中 @机器人回答即可继续原会话。审批、派活、定时任务等请求需要回原飞书话题发起，评论里不会执行，也不能通过评论批准操作。原方案确认卡继续有效。

评论续跑计入原方案的任务历史和预算；方案准备或修改期间不能确认，需等本轮结束后复查。失败和取消的轮次也会记录引擎已报告的消耗；引擎未报告的计数保持未知。

停止在队友通知提交前生效，会撤销尚未投递的交接单。通知或应用结果已经开始提交时，停止入口会提示无法撤回。预算拒派会显示失败并记录原因，不会显示交接成功。

每轮总时长上限覆盖全部重试与退避，退避期间仍可停止。临时 MCP 配置或 DSH 桥接文件被清理、损坏后，会在下次启动工具链前重新生成。

引擎未接收续跑时，澄清答案与审批结论仍可重试；已成功确认的应用请求会跨临时故障重试保留。会话或方案写盘失败时保留最后提交的状态，并发切目录不会污染另一条命令。

无效 CLI JSON 会被忽略；解析器或事件处理异常只结束当前轮次。取消任务时会等 CLI 进程树停止，再释放会话。

**主动式 Agent —— 不用人守着也能开工**

- `/schedule` 一句话创建定时任务；触发就是自动开话题派活，卡片上可暂停、恢复、删除
- 服务端日志巡检：正常时保持安静，异常才升级
- 审批流程：Agent 调 `request_approval` 后结束本轮，用户在卡片上拍板后续跑；这依赖引擎遵守指令，不会强制拦截任意命令

---

## 环境要求

| | |
|---|---|
| 运行时 | Node.js 22.13+、pnpm 11.5.3 |
| 聊天 | 飞书**话题群**（不是普通群），每台 bot 一个自建应用 |
| 引擎 | [Claude Code](https://docs.claude.com/zh-CN/docs/claude-code)、[Codex CLI](https://github.com/openai/codex) 或 [DeepSeek Harness](#deepseek-harness实验性)，已安装并配置凭证 |
| 系统 | macOS、Linux，或 Windows 下的 Git Bash / WSL2 |

请使用独立的操作系统账号安装、登录所选引擎。模型后端和引擎凭证由各 CLI 的用户级配置管理；
Agent OS 不提供模型访问，也不管理模型计费。

---

## 快速开始

```bash
git clone https://github.com/eilyeee/agent-os.git
cd agent-os
pnpm install --frozen-lockfile

cp .env.example .env
cp config/bots.example.json config/bots.json

# 填入凭证，替换 ownerOpenId，并指向一个已存在的受信任项目目录。
# 启动前先按 docs/deployment.md 完成飞书应用设置。
pnpm start:once
```

默认配置只启用一台开发 bot，产物写本地文件，不需要额外 Skill。工作区应与存放 `.env` 的
Agent OS 目录分开。完成[飞书应用设置](./docs/deployment.md#飞书应用设置)后，
在话题群里新开一个话题，@机器人：

```
@开发助手 读一下 package.json，告诉我这个项目怎么启动
```

话题里会出现任务卡片，随着 CLI 工作持续刷新，完成后变绿并给出答案。
在同一话题继续追问，上下文会自动续上。

---

## 配置

**`.env`** —— 只放密钥，永不提交。

```dotenv
BOTS_CONFIG=config/bots.json

FEISHU_DEVELOPER_APP_ID=cli_xxx
FEISHU_DEVELOPER_APP_SECRET=xxx
```

**`config/bots.json`** —— 名册、角色、引擎、工作目录。存的是**变量名**，不是凭证值。

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
      "role": "开发工程师，负责完成实现，并组织内部审查与测试",
      "skills": [],
      "resumeScope": "agent-os",
      "collaborationMaxRounds": 2
    }
  ]
}
```

`ownerOpenId` 要替换为本人在这台应用下的 ID。未设置 `allowedUserOpenIds` 时，只允许这个主人；
两者都没有时拒绝所有人的请求。`allowedChatIds` 可进一步限制聊天范围，
`allowedWorkspaceDirs` 可增加允许使用的项目目录，详见[访问权限](./docs/deployment.md#访问权限与工作目录)。

三 bot 团队使用 [`config/bots.team.example.json`](./config/bots.team.example.json)。
每台 bot 都需要独立凭证和各自视角下的主人 ID；Skill 和云文档按部署指南额外配置。
临时停用某台写 `"enabled": false`，它不会索取凭证，也不会建立连接。

---

## 命令

只有授权用户和聊天可使用。群里飞书会把消息投递给**每一台**机器人，带不带 @ 都一样，
所以由「点名」决定谁动手：@ 了谁就只有谁响应；谁都没 @ 就只有 Team Leader 响应。
单聊里没有点名一说，但仍需通过访问权限检查。

| 命令 | 作用 |
|---|---|
| `/help` | 列出可用命令 |
| `/status` | 当前 bot、会话、执行引擎、CLI 会话 ID、工作目录 |
| `/history` | 本群这台机器人做过的任务（跨话题），可按结局筛选、翻页查看 |
| `/cost` | 本群这台机器人的开销：累计 tokens、按来源拆分、最贵的几件 |
| `/team` | 团队名册：职责、引擎、Skill、连接状态 |
| `/new` | 在本话题开启全新 CLI 会话 |
| `/resume` | 从当前工作目录里挑一个历史 CLI 会话恢复 |
| `/compact [要求]` | 调用引擎原生能力整理当前上下文 |
| `/cd [目录]` | 查看或切换本话题的工作目录 |
| `/schedule [一句话]` | 查看本机器人的定时任务，或用一句话创建、调整 |
| `/close` | 停止正在运行的任务并关闭本话题会话 |
| `/claude <任务>` | 新话题使用 Claude Code |
| `/codex <任务>` | 新话题使用 Codex |
| `/dsh <任务>` | 新话题使用 DeepSeek Harness |

**执行引擎在话题创建时定死**，想切换就新开话题 —— 各 CLI 的 session id 并不互通。

### DeepSeek Harness（实验性）

适配官方 `@deepseek-ai/dsh@0.2.1-rc.5`，建议用 Node.js 24.9+ 运行 DSH，并确保 Agent OS 的 `PATH` 能找到该版本的 `dsh`。旧版 DSH 不支持本适配器所需的 JSON 事件与原生会话续接。

```bash
npm install -g @deepseek-ai/dsh@0.2.1-rc.5
dsh --profile headless --help
```

先按[官方 headless 文档](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/bundle/headless/README.zh.md)配置 DSH 的模型与凭证；凭证留在 DSH 用户目录（默认 `~/.dsh/.env`，也可指定 `$DSH_HOME/.env`），不要写进 Agent OS 的 `.env` 或 bot JSON。然后在新话题发送 `/dsh 任务`，或将 `defaultCli` 设为 `"dsh"`。

支持任务执行、同话题自动续接、工具进度、用量统计，以及澄清、审批、派活、定时任务等五个 MCP 应用工具。Agent OS 自动生成临时 MCP patch 和原生事件桥接，不改写 DSH 用户配置，也不新增模型 API 依赖。五个应用工具全部注册后才启动任务；MCP 或桥接加载失败会阻止执行。子 Agent 与 PTC 内的应用工具请求也通过桥接送回主话题，用户回答后续跑主会话。同一次 CLI 执行只受理一个成功的应用请求；并行的后续请求会明确返回错误，等待当前请求处理后再提交。DSH 使用 `workspace-write` 与非交互拒绝策略：需要引擎提权的操作会被拒绝，飞书审批通过也不会绕过其沙箱。

用量包含主任务、子 Agent 后代和有采样的失败重试；任一步缺失计数时不会把部分和展示成精确总量。普通读写工具的 JSONL 展示参数截断不代表工具失败，也不会阻止成功结算；应用请求仍只使用无损桥接参数。

当前 headless 没有历史列表或原生命令路由，`/resume` 列表与手动 `/compact` 暂不可用；原话题继续自动续接，压缩由 DSH 原生自动处理，`/new` 可开启新上下文。应用工具使用原生最终结果中的完整参数，不从被截断的 JSONL 通知派发；首轮失败或取消后仍保存原生会话绑定，可在原话题继续。历史的验证标记只认已创建子任务的原生 preset 身份（`tester` / `code-reviewer`），不从自由描述猜角色。模型配置完成后，可在受信任的测试目录运行 `pnpm probe:tool dsh /absolute/workspace` 验证 MCP 链路。

---

## 架构

```
src/im/     接入层    长连接、事件解析、卡片构建
src/core/   内核层    会话、状态机、持久化、协作
src/cli/    引擎层    每种 CLI 的参数与协议 → 统一 CliEvent
src/app/    编排层    一条消息在系统里怎么流动
src/mcp/    工具层    本地 MCP Server，向各 CLI 暴露同一套应用工具
```

**内核不依赖任何消息平台。** 引擎差异被压缩进三个 adapter 方法 ——
`buildArgs`、`buildResumeArgs`、`parseEvents` —— 所以接入新 CLI 是扩展适配器，
而不是复制第二条流水线。

分层规则、工程约定和值得提前知道的坑，见 [`AGENTS.md`](./AGENTS.md)（英文，供 AI Agent 读取）。

---

## 路线图

| | 里程碑 | 交付 | 状态 |
|---|---|---|---|
| M0 | 项目骨架 + CLI 侦察 | 脚手架、事件流解析器 | 已实现 |
| M1 | 飞书接入 | 长连接、@提及、富媒体、实时卡片 | 已实现 |
| M2 | 会话内核 | 状态机、崩溃安全的持久化 | 已实现 |
| M3 | 接入执行引擎 | Claude Code + Codex、流式卡片、停止按钮 | 已实现 |
| M4 | 多 bot + 协作 | 独立会话、工作目录、审查交接 | 已实现 |
| M5 | Agent 团队 + 重构 | 团队注册表、`/team`、编排层 | 已实现 |
| M6 | MCP 工具 + 产品流 | 澄清表单、Spec、确认、云文档 | 已实现 |
| M7 | 主动式 Agent | 定时任务、cron、审批门 | 已实现 |
| M8 | 部署 | pm2 配置、重启恢复 | 已实现 |

`pnpm verify` 运行本地验证套件：`check` 覆盖纯逻辑
（Schema、状态机、持久化、数据迁移、cron、事件解析、卡片渲染），
`integration` 用假飞书驱动真实的编排链路（命令分发、卡片回调、澄清与审批流程、
权限校验、会话路由）。仍有两层没覆盖：飞书长连接和 CLI 子进程。
它们需要真实凭证和真实话题群；请按[真实环境验收](./docs/deployment.md#真实环境验收)逐项检查。

---

## 安全

在聊天软件里 headless 运行意味着没有交互式权限确认界面，所以引擎是带着
`--dangerously-skip-permissions` / `--yolo` 启动的（Windows Codex 使用等价的绕过参数）。
引擎拥有运行它的操作系统账号所能使用的权限。

- 使用独立低权限账号或隔离容器，只放入任务需要的文件和凭证
- 仅授权受信任的用户和聊天；授权成员共享机器人账号和可访问的 CLI 上下文，本项目不提供多租户隔离
- 工作区与存放 `.env`、`data/` 的 Agent OS 目录分开，允许写入前先留可恢复的基线
- `allowedWorkspaceDirs` 检查 Agent OS 选择的工作目录并解析符号链接，不能限制引擎工具读写其他文件
- 审批卡片依赖引擎主动调用 `request_approval` 并遵守等待指令；忽略指令的引擎仍能直接执行命令。强制边界应由操作系统隔离提供
- 消息入口日志不记录正文；任务历史和引擎原生历史仍会保存指令与答案，应保护 `data/` 和引擎账号的历史目录

常驻运行、飞书权限、可选 Skill 和验收步骤见[部署指南](./docs/deployment.md)。

---

## 许可

[MIT](./LICENSE)。随仓库分发的第三方 Skill 声明见
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
