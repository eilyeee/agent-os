# 部署指南

本文负责从空环境到单 bot 首次运行、访问控制和真实环境验收。

## 运行边界

Agent OS 是自托管的命令层，启动本机 Claude Code 或 Codex，不直接调用模型 API。
当前默认接入飞书服务；国际版 Lark 的服务域名和租户配置需要另行适配、验证。

引擎使用 `--dangerously-skip-permissions` / `--yolo`（Windows Codex 使用等价绕过参数），
所以它能使用运行账号的文件、网络和命令权限。请在独立低权限操作系统账号或隔离容器中运行，
不要使用管理员账号，也不要在该环境放入与任务无关的生产凭证。

`request_approval` 是协作流程：引擎需要主动请求并停止执行，用户拍板后 Agent OS 再续接。
它不拦截任意 Shell 命令，不构成强制安全策略。目录白名单也只约束启动目录，不能替代引擎或系统沙箱。

## 准备本机环境

1. 安装 Node.js **22.13+**，以及 `package.json` 的 `packageManager` 声明的 pnpm **11.5.3**。
   pnpm 安装方式见[官方安装说明](https://pnpm.io/installation)。
2. 在准备运行 Agent OS 的同一账号下，安装并登录至少一个受支持引擎：
   [Claude Code](https://code.claude.com/docs/en/overview) 或 [Codex CLI](https://github.com/openai/codex)。
   模型、代理、登录态和计费由引擎自己的配置管理，不放进 Agent OS 的配置文件。
3. 选择已存在且可信的目标项目。建议它与 Agent OS 仓库同级，例如 `../my-project`，
   而不是把 Agent OS 仓库本身交给 bot 修改。允许写入前先保存一个可恢复的版本。
4. 确保这个账号的终端可以正常运行所选引擎。首次登录和安装属于交互式准备步骤，
   不要等到通过飞书首次派活时才处理。

目录分开可以减少误读，但不隔离同一账号下的文件。引擎仍可能访问这个账号可读的 `.env`；
需要强制限制时，应在操作系统或容器层控制挂载、文件权限和网络权限。

## 安装与配置

```bash
git clone https://github.com/eilyeee/agent-os.git
cd agent-os
pnpm install --frozen-lockfile
cp .env.example .env
cp config/bots.example.json config/bots.json
```

`.env` 只填写默认 developer bot 的 App ID / App Secret。`config/bots.json` 存放环境变量名，
不要把 App Secret 值写进 JSON。默认单 bot 配置不依赖额外 Skill，产物写在本地。

编辑 `config/bots.json`：

- 将 `workspace` 改为已存在的可信项目目录；相对路径以启动 Agent OS 时的目录为基准。
- 将 `ownerOpenId: "ou_replace_me"` 改为本人在这台应用下的 `open_id`。
- 使用 Codex 时将 `defaultCli` 改为 `"codex"`；引擎只在新话题创建时选定。
- 默认只允许 `ownerOpenId`，按需要增加下面的访问配置。

获得 `open_id` 的一种方式：完成下节飞书设置并启动本地进程，向机器人发送一条测试消息，
查看本地准入日志里的 `sender=`；日志里的 `chat=` 可用于限制聊天。
占位 ID 不会授权任何真实使用者。填好 ID 后重启单次运行进程；开发 watch 模式会重新加载配置。
不要使用从另一台应用的日志取得的 `open_id` 代填。

不要把含真实 ID、任务内容、路径或凭证的日志直接粘贴到公开问题讨论中。

## 飞书应用设置

使用[飞书开发者后台](https://open.feishu.cn/app)创建企业自建应用，并开启机器人能力。
每个 bot 对应一台独立应用；群里的 webhook 自定义机器人不能作为本项目的消息入口。
先将应用可用范围设为自己或少量可信测试人员。

### 权限与事件

先完成单 bot 文本任务，再按需开放其他能力。按对应接口页面的“权限要求”在应用后台申请权限，
以当前租户和应用后台实际列出的名称为准，不要一次性授予所有权限。

| 能力 | 需要配置的内容 |
|---|---|
| 接收任务 | 接收单聊消息、群内 @机器人消息；需要 Team Leader 接收无 @群消息时再申请相应群消息读取权限。订阅 `im.message.receive_v1` |
| 回复与任务卡片 | 发送／回复消息、更新消息卡片，以及读取机器人信息 |
| 按钮与表单 | 在回调配置中订阅新版 `card.action.trigger`，接收方式选择长连接 |
| 图片／文件任务（可选） | 读取消息中的资源；不需要处理附件时可暂不开启 |
| 人名展示（可选） | 读取所需的用户基本信息；没有授权时任务可退化为 ID 展示 |
| 被添加到群 | 可订阅 `im.chat.member.bot.added_v1`；项目只接收该事件，不据此派活 |
| 云文档（可选） | 文档与评论读写、评论事件订阅和表情操作所需权限；详见下文 |

官方参考：[接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)、
[长连接接收事件](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-)、
[回调配置与接收](https://open.feishu.cn/document/event-subscription-guide/callback-subscription/callback-overview)。

### 建立连接与发布

1. 填好 App ID / App Secret，并确认配置的工作区存在，然后在仓库根目录启动：

   ```bash
   pnpm start:once
   ```

2. 在应用后台的“事件与回调”中，将事件及回调的订阅方式设置为使用长连接。
   保存长连接配置时可能要求本地客户端已经在线；以后台提示为准。
   本项目不启动 HTTP 服务，不需要公网回调 URL。
3. 添加上表的消息事件和卡片回调。创建应用版本，检查可用范围，按租户的审核流程发布，
   确认配置和权限已生效。发布与可用范围参考[官方应用使用说明](https://open.feishu.cn/document/introduction-2?lang=zh-CN)。
4. 创建飞书话题群，将 bot 加入群；在新话题里 @机器人发送 `/help`。
   如果还没有正确配置主人 ID，先从本地准入日志取得 `sender=`，填好后重启再试。
5. 确认 `/help` 能响应后，发送一个只读任务，例如“读取 package.json，告诉我怎么启动”。
   验证卡片持续更新、最终结果和同话题追问，再开始允许写文件的任务。

三 bot 时重复每台应用的权限、连接、发布和加群操作。只开一台连接不会自动替其他应用完成设置。

## 访问权限与工作目录

下列字段写在 `bots` 数组中对应的 bot 对象上：

| 字段 | 未配置时 | 显式配置后 |
|---|---|---|
| `ownerOpenId` | 可由 `.env` 的 `OWNER_OPEN_ID` 兜底 | 用于默认访问授权、定时通知及自动轮次的人类拍板归属 |
| `allowedUserOpenIds` | 仅允许该 bot 的 `ownerOpenId`；没有主人则拒绝所有人 | 仅允许数组中的人；`[]` 拒绝所有人，主人也必须在名单里 |
| `allowedChatIds` | 不额外限制聊天，仍须通过用户名单 | 只允许列出的群／单聊；`[]` 拒绝全部聊天 |
| `allowedWorkspaceDirs` | 仅允许该 bot 的 `workspace` 及其子目录 | 只允许数组中的目录及其子目录；如仍需默认目录，必须也列入 |

多人、多项目示例（必须替换所有占位 ID 和路径）：

```json
{
  "ownerOpenId": "ou_replace_owner",
  "allowedUserOpenIds": ["ou_replace_owner", "ou_replace_teammate"],
  "allowedChatIds": ["oc_replace_topic_group"],
  "allowedWorkspaceDirs": ["../my-project", "../another-project"]
}
```

`open_id` 按飞书应用隔离：同一个人在不同 bot 眼里可能是不同 ID。
多人访问时逐台填写名单，不能把一台应用查到的 ID 原样复制给另一台。

人类发来的普通消息、命令、卡片操作都要通过访问检查；云文档评论还要求是原方案的主人。
自动交接要求接收方配置 `ownerOpenId`，且该负责人仍在人员名单中；发送和领取两端都会检查。
取件码只在原群、原话题生效，转发通知不会授权其他话题执行。
运行中任务的停止按钮和 `/close` 只允许该轮主人操作。
**授权成员共享同一 bot 的账号和可访问的会话，不提供不同成员之间的文件或上下文隔离。**

工作目录检查会解析真实路径，并拒绝通过 `..`、绝对路径或符号链接跳出允许范围。
它限制 Agent OS 为任务选择的 `cwd`，不限制 Shell、编辑器和子 Agent 能访问的其他文件。
修改目录名单后，原会话、交接或定时任务若指向不再允许的目录，也需要重新调整。

## 可选三 bot 团队与 Skill

单 bot 跑通后，再以 `config/bots.team.example.json` 为起点。
三台分别承担 CEO 助理、产品经理和开发者；各自填入凭证及主人 ID，并保持 `teamLeader` 指向启用成员。
示例没有设置 `reviewBy`，不会在每轮完成后自动启动跨 bot 互审。
长期成员用 `dispatch_task` 显式交接；代码审查与测试优先放在开发者 CLI 内部的子 Agent 中。

团队示例的产品经理声明了 `grill-me`、`to-spec`、`to-tickets`。将
[`workspace-template`](../workspace-template/README.md) 的定制澄清 Skill 和 tracker 约定复制到目标工作区，
再按该说明安装需要的第三方 Skill。默认单 bot 的 `skills: []` 不需要这一步。

示例默认 `defaultProductDeliveryMode: "local"`，产品方案只保存本地 Markdown。
需要飞书云文档时再进行以下配置：

1. 按 [larksuite/cli 的官方说明](https://github.com/larksuite/cli)安装并配置云文档工具及登录态。
2. 为产品 bot 安装并声明 `lark-doc`、`lark-drive` Skill，将 `defaultProductDeliveryMode` 改为 `"lark-doc"`。
3. 在飞书应用里申请所使用的文档、评论读写和评论表情接口权限，并订阅 `drive.notice.comment_add_v1`。
   代码在声明 `lark-drive` 的 bot 启动时还会调用评论事件订阅接口。
4. 为实际使用的文档授予相应访问权限；接口授权不等于自动拥有所有人的文档。
   参见[云文档接入流程](https://open.feishu.cn/document/server-docs/docs/docs-overview?lang=zh-CN)。
5. 使用支持的 docx 链接验证产物、方案确认卡与原方案主人 @bot 的评论评审。
   评论中的指令也会进入引擎上下文，只在可信文档上开启这条链路。
   已确认或被替换的方案不会再执行排队中的评论；需要继续修改时，请在话题中发起新的方案评审。

可选工具的安装、认证以及云文档读写需要在实际运行账号中完成；本地假飞书测试不能验证它们。

## 本地验证与常驻运行

在仓库根目录执行：

```bash
pnpm build
pnpm verify
```

验证使用假飞书和假引擎，不需要配置真实飞书凭证。它不证明真实长连接、CLI 登录态、
Windows 进程取消、云文档权限或目标账号的文件隔离已经正确。

开发期间可用 `pnpm dev` 自动重载源码、`.env` 和配置。常驻进程可在本地安装 pm2 后使用：

```bash
pnpm pm2:start
pnpm pm2:logs
```

pm2 的系统启动和版本安装方式见 [pm2 官方文档](https://pm2.keymetrics.io/docs/usage/quick-start/)。
实例配置只启用单进程：会话运行态、交接收件箱和调度去重都在进程内存里，不能通过多开实例扩容。
`pnpm pm2:stop` 用于停止本实例；升级依赖或配置后重新执行 `pnpm pm2:start`。

## 数据、日志与排查

- `.env`、`config/bots.json`、`data/` 和日志都是机器本地内容，不要提交或打包公开。
- 任务记录与会话元信息保存在 `data/`，CLI 还会在自己的用户目录保存原生历史。
  备份、保留和删除这两处数据应一起考虑；停止任务不会自动删除历史。
- 消息入口日志省略正文，但仍记录路由所需的 bot／用户／聊天 ID。故障信息、任务标题与历史也可能包含敏感内容，分享前仍应脱敏。
- 启动失败：先看提示里的配置文件和字段，检查工作区是否存在、凭证是否填写、`teamLeader` 是否启用。
- 有连接但无响应：检查应用可用范围、发布版本、消息权限、事件订阅、话题群、@目标和用户／聊天名单。
- 按钮无效：检查新版 `card.action.trigger` 的长连接回调，确认点击者在名单中且拥有当前操作权限。
- 找不到 Skill：确认它安装在目标 bot 的工作区或对应运行账号下，不能只装在另一个人的用户目录。
- 文件监听报 `EMFILE`：程序会降级为轮询配置文件；同时检查系统文件／监听资源及其他 watcher。若轮询也无法访问文件，按日志排查权限和目录，不应将未跑完的套件当成通过。

## 真实环境验收

在准备使用的平台和运行账号下逐项记录结果；本仓库不会替你执行需要真实凭证的验收。

- [ ] 单 bot 的 `/help`、只读任务、任务卡片、最终回答和同话题续接正常
- [ ] 非名单用户／聊天不能触发引擎，也不能通过转发卡片绕过检查
- [ ] `/cd` 只进入允许目录；目录外路径、相邻前缀目录、逃逸符号链接被拒绝
- [ ] 运行中任务只有主人能通过按钮或 `/close` 中止；取消后整个进程树退出，会话可继续使用
- [ ] Claude Code 与 Codex 分别验证新会话、续接、恢复和压缩；只声明实际验证过的平台与引擎版本
- [ ] 三 bot 时分别验证每台主人 ID、指定接单、交接领取、澄清和审批后的续跑
- [ ] 定时任务的触发、暂停、删除和进程重启恢复正常
- [ ] 云文档开启后，验证文档权限、方案确认与主人评论评审；未开启可记为不适用
- [ ] 检查任务数据、原生 CLI 历史和日志的存放位置，确认访问账号及备份范围符合预期
