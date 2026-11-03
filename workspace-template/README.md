# workspace-template

本目录提供可选的产品需求流程模板。默认单 developer bot 配置不需要安装这些 Skill。
三 bot 示例的产品经理启用后，把内容复制到 **bot 的工作目录**
（`config/bots.json` 里的 `workspace`），与 Agent OS 仓库分开：

```bash
cp -R workspace-template/.agents /path/to/your-project/
cp -R workspace-template/docs /path/to/your-project/
```

请先检查目标目录，避免覆盖已有的同名自定义 Skill 或 tracker 约定。

- `.agents/skills/grill-me/`：定制的需求澄清 Skill，通过 Agent OS 的
  `request_clarification` 工具展示飞书表单。
- `docs/agents/issue-tracker.md`：本地 Markdown Issue Tracker 的约定，
  产品经理产出 Spec 和 Tickets 时使用。

`to-spec`、`to-tickets` 来自第三方项目
[mattpocock/skills](https://github.com/mattpocock/skills)。按上游安装说明将需要的 Skill
安装到目标工作区，避免从网络安装同名 `grill-me` 覆盖这里的定制版本。
仓库内已有的 Skill 来源与许可见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

只有启用云文档交付时才需要 [larksuite/cli](https://github.com/larksuite/cli) 提供的
`lark-doc`、`lark-drive`；按其官方说明安装、认证后，再在产品 bot 的 `skills` 中声明它们。

安装后，使用实际运行账号和所选引擎确认 Skill 能被发现，并能调用 Agent OS 的 MCP 工具。
启动时“未发现 Skill”的提示只检查候选文件是否存在；没有提示不代表引擎已经加载成功。
具体的云文档权限与真实验收步骤见[部署指南](../docs/deployment.md)。
