/**
 * Agent OS 的本地 MCP Server：向执行引擎暴露同一套应用工具。
 * 只定义参数契约，不含任何执行逻辑——工具调用一律交回 Agent OS 处理。
 * 走 stdio，不监听端口，由各个 CLI 在启动时拉起。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { clarificationToolShape } from "../core/clarification.js";
import { productSpecToolShape } from "../core/product-spec.js";
import { approvalToolShape } from "../core/approval.js";
import { scheduleManageToolShape } from "../core/schedule.js";
import { dispatchTaskToolShape } from "../core/collaboration.js";
import {
  APPROVAL_TOOL_NAME,
  CLARIFICATION_TOOL_NAME,
  DISPATCH_TASK_TOOL_NAME,
  PRODUCT_SPEC_TOOL_NAME,
  SCHEDULE_MANAGE_TOOL_NAME,
} from "../cli/app-tools.js";

const server = new McpServer({ name: "agent-os", version: "0.1.0" });

server.registerTool(
  CLARIFICATION_TOOL_NAME,
  {
    title: "向用户提问",
    description: [
      "当需求仍有会实质影响方案的歧义时，调用此工具向用户展示飞书问题卡片。",
      "一次最多提交 5 个问题，每题提供 2 到 4 个清晰、互斥的选项，并标记推荐项。",
      "不要添加「其他」选项，卡片会自动提供自定义输入框。",
      "调用后立即结束本轮，不要自行补全用户答案。",
    ].join(""),
    inputSchema: clarificationToolShape,
  },
  async ({ questions }) => ({
    content: [
      {
        type: "text" as const,
        text: `已把 ${questions.length} 个问题交给 Agent OS，请等待用户回答。`,
      },
    ],
  }),
);

server.registerTool(
  PRODUCT_SPEC_TOOL_NAME,
  {
    title: "提交产品方案",
    description: [
      "产品方案已经生成后，调用此工具提交唯一的待确认产物。",
      "deliveryMode=local 时提交 specPath 与 ticketsPath，并确保文件真实存在。",
      "deliveryMode=lark-doc 时只提交 documentUrl，且必须是创建或更新成功后返回的文档链接；",
      "该文档必须同时包含产品说明与「实现任务（Tickets）」章节。",
      "同一份方案不要同时维护本地 Markdown 和飞书云文档，避免两个来源互相覆盖。",
      "summary 只写便于快速了解方案的摘要，完整内容保留在所选产物中。",
      "调用后停止工作，不要实现代码，也不要委派团队成员。",
    ].join(""),
    inputSchema: productSpecToolShape,
  },
  async () => ({
    content: [
      {
        type: "text" as const,
        text: "唯一的产品方案产物已交给 Agent OS，等待用户查看。",
      },
    ],
  }),
);

server.registerTool(
  APPROVAL_TOOL_NAME,
  {
    title: "请求高危操作审批",
    description: [
      "执行任何高危操作前必须先调用此工具，等待人拍板。",
      "高危包括但不限于：重启或下线服务、修改生产数据、删除文件或分支、",
      "对外发布、变更权限与配置、任何不可逆或影响他人的动作。",
      "impact 要写清影响范围，command 写出将要执行的确切命令。",
      "调用后立即结束本轮，绝不要先执行再补审批，也不要寻找绕过审批的等价做法。",
    ].join(""),
    inputSchema: approvalToolShape,
  },
  async ({ title }) => ({
    content: [
      {
        type: "text" as const,
        text: `「${title}」的审批请求已交给 Agent OS，等待用户拍板后会恢复本会话。`,
      },
    ],
  }),
);

server.registerTool(
  SCHEDULE_MANAGE_TOOL_NAME,
  {
    title: "管理定时任务",
    description: [
      "用它增删改定时任务。cron 是五段式：分 时 日 月 周。",
      "prompt 写触发时要交给 Agent 的完整任务描述，触发时会自动开一个新话题执行。",
      "查询现有任务请让用户发送 /schedule，不要用此工具做列表查询。",
      "调用后立即结束本轮，Agent OS 会把结果用卡片回给用户。",
    ].join(""),
    inputSchema: scheduleManageToolShape,
  },
  async ({ action }) => ({
    content: [
      {
        type: "text" as const,
        text: `定时任务操作（${action}）已交给 Agent OS。`,
      },
    ],
  }),
);

server.registerTool(
  DISPATCH_TASK_TOOL_NAME,
  {
    title: "把任务派给团队成员",
    description: [
      "把一项工作交给团队名册里的另一位成员。",
      "task 要写成对方可以独立执行的完整描述，对方看不到你这一轮的上下文。",
      "只能派给名册里真实存在的飞书 bot，不要用它调度 CLI 内部的子 Agent。",
      "调用后立即结束本轮，等待对方完成后结果会回到同一个话题。",
    ].join(""),
    inputSchema: dispatchTaskToolShape,
  },
  async ({ toBotId }) => ({
    content: [
      {
        type: "text" as const,
        text: `任务已交给 Agent OS 派发给 ${toBotId}。`,
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
