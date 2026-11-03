/** 解析 config/bots.json，并为每台 bot 组装执行引擎的提示词。 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { CliId } from "../cli/types.js";
import { resolveWorkspacePath } from "./workspace.js";

const ProductDeliveryModeSchema = z.enum(["local", "lark-doc"]);
export type ProductDeliveryMode = z.infer<typeof ProductDeliveryModeSchema>;

export interface BotConfig {
  id: string;
  appId: string;
  appSecret: string;
  defaultCliId: CliId;
  role: string;
  skills: string[];
  systemPrompt: string;
  workspaceDir: string;
  /**
   * 这台 bot 眼里「你」的 open_id，用于定时任务通知和审批点名。
   * open_id 按应用隔离：同一个人在不同飞书应用下是不同的 open_id，
   * 所以它必须按 bot 配，全局一个值在多 bot 下必然有一台用错。
   */
  ownerOpenId?: string;
  /** 未设置时只允许负责人；空名单拒绝所有人。open_id 按 bot 分别配置。 */
  allowedUserOpenIds?: string[];
  /** 未设置时不额外限制群；空名单拒绝所有群和单聊。 */
  allowedChatIds?: string[];
  /** 限制可选工作目录，不是文件访问沙箱；未设置时只允许 workspace 及其子目录。 */
  allowedWorkspaceDirs?: string[];
  /**
   * /resume 列出哪些会话。
   * agent-os（默认）：只列 Agent OS 自己派发过的。
   * workspace：把这个工作目录下所有引擎会话都列出来，包括人在终端里开的——
   *   方便找回终端里的工作，但群里任何人都能把它恢复出来继续跑，
   *   而引擎是带无人值守参数运行的。要用就明确知道自己在开什么。
   */
  resumeScope: "agent-os" | "workspace";
  /**
   * 多久没有任何输出算卡死，分钟。量沉默而不是量总时长：
   * 固定总超时分不清「干了 25 分钟」和「卡了 25 分钟」，
   * 而按票实现一个功能本来就要几十分钟——真机上一张票跑了 13 分钟就被 10 分钟的
   * 固定超时杀在了最后运行测试那一步，代码其实已经写完了。
   * 阈值要宽于最长的一次合法沉默（跑测试套件时 stdout 会安静十几分钟）。
   */
  idleTimeoutMinutes: number;
  /** 总时长硬上限，分钟。空闲计时器对「一直在产出」的死循环无效，靠它兜底。 */
  maxRuntimeMinutes: number;
  /**
   * 一件事的 token 预算。超了就不再自动续跑。
   *
   * 时长上限兜不住「一直在正常产出但方向错了」——那种情况每分钟都在烧钱
   * 而且看起来很健康。真实数据里有一轮跑了 216 分钟才被时长上限切掉。
   *
   * **只拦自动续跑，不拦人**：交接链会一轮接一轮地自己跑下去，那是真正会失控的地方；
   * 人拍板后的续跑、人发的新消息都不该被拦。
   */
  maxTokensPerTask: number;
  /** 固定的审查关系；团队工作流成熟后由 Team Leader 动态派发。 */
  reviewBy?: string;
  collaborationMaxRounds: number;
}

export interface AgentOsConfig {
  teamLeaderId: string;
  defaultProductDeliveryMode: ProductDeliveryMode;
  bots: BotConfig[];
  /** 配置允许自定义凭证变量名，子进程过滤不能只认 FEISHU_ 前缀。 */
  credentialEnvNames: string[];
}

type Environment = Record<string, string | undefined>;

const BotSchema = z.object({
  id: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9_-]{0,31}$/,
      "bot id 只能使用小写字母、数字、连字符和下划线",
    ),
  // 配置里只写环境变量名，真实凭证留在 .env。
  appIdEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  appSecretEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  defaultCli: z.enum(["claude", "codex"]),
  role: z.string().trim().min(1),
  skills: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
    .optional()
    .default([]),
  workspace: z.string().trim().min(1).optional(),
  // 只校验前缀形状，字符集放宽：拒掉一个合法 open_id 比放进一个怪值更糟。
  ownerOpenId: z.string().regex(/^ou_[A-Za-z0-9_-]+$/).optional(),
  allowedUserOpenIds: z.array(z.string().regex(/^ou_[A-Za-z0-9_-]+$/)).optional(),
  allowedChatIds: z.array(z.string().regex(/^oc_[A-Za-z0-9_-]+$/)).optional(),
  allowedWorkspaceDirs: z.array(z.string().trim().min(1)).optional(),
  resumeScope: z.enum(["agent-os", "workspace"]).optional().default("agent-os"),
  idleTimeoutMinutes: z.number().int().min(1).max(120).optional().default(15),
  maxRuntimeMinutes: z.number().int().min(1).max(600).optional().default(120),
  // 默认 500 万：真实数据里一件事最贵的约 130 万，留足余量但不至于放任。
  maxTokensPerTask: z
    .number()
    .int()
    .min(100_000)
    .max(100_000_000)
    .optional()
    .default(5_000_000),
  systemPrompt: z.string().trim().optional().default(""),
  reviewBy: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/)
    .optional(),
  /**
   * 这个值有两种语义，配置时要分清：
   * - 配了 reviewBy 的自动互审：continueCollaboration 只要 round < maxRounds 就无条件回弹，
   *   没有别的终止条件，所以它实际上等于「必须跑满的往返次数」。
   *   开发↔审查这一对应该填 2：开发 → 审查 → 开发按意见处理 → 结束。
   * - Team Leader 用 dispatch_task 显式派活：下一步交给谁由模型决定，
   *   这时它才是纯粹的防失控安全阀，可以放大到十几轮。
   */
  collaborationMaxRounds: z.number().int().min(1).max(32).optional().default(2),
  enabled: z.boolean().optional().default(true),
});

const BotConfigFileSchema = z.object({
  teamLeader: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  defaultProductDeliveryMode: ProductDeliveryModeSchema.optional().default(
    "lark-doc",
  ),
  bots: z.array(BotSchema).min(1),
});

export function parseAgentOsConfig(
  input: unknown,
  env: Environment,
  baseDirectory = process.cwd(),
): AgentOsConfig {
  const parsed = BotConfigFileSchema.parse(input);

  const ids = new Set<string>();
  for (const bot of parsed.bots) {
    if (ids.has(bot.id)) throw new Error(`bot id 不能重复: ${bot.id}`);
    ids.add(bot.id);
  }

  const configs: BotConfig[] = parsed.bots
    // enabled:false 在解析阶段就过滤掉，停用的 bot 不索取凭证也不建连接。
    .filter((bot) => bot.enabled)
    .map((bot) => {
      const appId = env[bot.appIdEnv]?.trim() ?? "";
      const appSecret = env[bot.appSecretEnv]?.trim() ?? "";
      if (!appId) throw new Error(`bot ${bot.id} 缺少环境变量 ${bot.appIdEnv}`);
      if (!appSecret) {
        throw new Error(`bot ${bot.id} 缺少环境变量 ${bot.appSecretEnv}`);
      }
      return {
        id: bot.id,
        appId,
        appSecret,
        defaultCliId: bot.defaultCli,
        role: bot.role,
        skills: [...new Set(bot.skills)],
        systemPrompt: bot.systemPrompt,
        workspaceDir: resolveWorkspacePath(
          bot.workspace ?? env.CLI_WORKDIR ?? ".",
          baseDirectory,
        ),
        // 没单独配就退回全局值：单 bot 场景下这仍然是对的。
        ...(bot.ownerOpenId ?? env.OWNER_OPEN_ID
          ? { ownerOpenId: bot.ownerOpenId ?? env.OWNER_OPEN_ID!.trim() }
          : {}),
        ...(bot.allowedUserOpenIds !== undefined ? { allowedUserOpenIds: bot.allowedUserOpenIds } : {}),
        ...(bot.allowedChatIds !== undefined ? { allowedChatIds: bot.allowedChatIds } : {}),
        ...(bot.allowedWorkspaceDirs !== undefined
          ? { allowedWorkspaceDirs: bot.allowedWorkspaceDirs.map((path) => resolveWorkspacePath(path, baseDirectory)) }
          : {}),
        resumeScope: bot.resumeScope,
        idleTimeoutMinutes: bot.idleTimeoutMinutes,
        maxRuntimeMinutes: bot.maxRuntimeMinutes,
        maxTokensPerTask: bot.maxTokensPerTask,
        ...(bot.reviewBy ? { reviewBy: bot.reviewBy } : {}),
        collaborationMaxRounds: bot.collaborationMaxRounds,
      };
    });

  if (configs.length === 0) throw new Error("至少需要启用一个 bot");

  const enabledIds = new Set(configs.map((config) => config.id));
  if (!enabledIds.has(parsed.teamLeader)) {
    throw new Error(`teamLeader 指向未启用的 bot: ${parsed.teamLeader}`);
  }
  for (const config of configs) {
    if (config.reviewBy && !enabledIds.has(config.reviewBy)) {
      throw new Error(
        `bot ${config.id} 的 reviewBy 指向未启用的 bot: ${config.reviewBy}`,
      );
    }
    if (config.reviewBy === config.id) {
      throw new Error(`bot ${config.id} 不能把自己配置为 reviewBy`);
    }
  }

  return {
    teamLeaderId: parsed.teamLeader,
    defaultProductDeliveryMode: parsed.defaultProductDeliveryMode,
    bots: configs,
    // 停用只是不开连接；同一进程环境中的停用 bot 凭证仍然不能交给引擎。
    credentialEnvNames: parsed.bots.flatMap((bot) => [bot.appIdEnv, bot.appSecretEnv]),
  };
}

export async function loadAgentOsConfig(
  filePath: string,
  env: Environment = process.env,
  baseDirectory = process.cwd(),
): Promise<AgentOsConfig> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `找不到 bot 配置文件: ${filePath}。请复制 config/bots.example.json 后填写配置。`,
      );
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `bot 配置文件不是合法 JSON（${filePath}）：${(error as Error).message}`,
    );
  }
  try {
    return parseAgentOsConfig(parsed, env, baseDirectory);
  } catch (error) {
    // Schema 失败要翻译成人能读的定位信息；直接把 ZodError 序列化出来
    // 会甩给运维一段没有文件名的 JSON。
    if (error instanceof z.ZodError) {
      const issues = error.issues
        .map((issue) => `  - ${issue.path.join(".") || "(根)"}：${issue.message}`)
        .join("\n");
      throw new Error(`bot 配置文件字段有误（${filePath}）：\n${issues}`);
    }
    // 缺环境变量、teamLeader 不存在这类是语义问题，本来就带着可执行的说明，原样抛出。
    throw error;
  }
}

/**
 * 每次派活的提示词都以它开头（见 buildBotPrompt）。
 * 用来在引擎的历史会话里区分「Agent OS 派发的」和「人在终端里自己开的」。
 */
export const AGENT_OS_PROMPT_MARKER = "你的角色：";

/** 声明了这些 Skill 的成员才负责产出产品方案，也只有它们的 request_spec_approval 会被接受。 */
export const PRODUCT_DOCUMENT_SKILLS = ["to-spec", "to-tickets", "lark-doc"];

/** 每次派活都把角色、团队上下文、Skill 规则和飞书输出约束一起交给引擎。 */
export function buildBotPrompt(
  config: Pick<BotConfig, "role" | "skills" | "systemPrompt">,
  prompt: string,
  teamContext = "",
  defaultProductDeliveryMode: ProductDeliveryMode = "lark-doc",
): string {
  const projectSkillPolicy = config.skills.length
    ? [
        "项目 Skill 加载规则（优先级不可颠倒）：",
        "- 先读取当前工作区 `.agents/skills/<skill>/SKILL.md`。",
        "- 不存在时再读取 `.claude/skills/<skill>/SKILL.md`。",
        "- 只有两个工作区路径都不存在时，才允许回退到用户级或全局同名 Skill。",
        `本次必须执行：${config.skills.map((skill) => `$${skill}`).join("、")}`,
      ].join("\n")
    : "";

  const productDeliveryPolicy = config.skills.some((skill) =>
    PRODUCT_DOCUMENT_SKILLS.includes(skill),
  )
    ? [
        "产品方案交付规则（必须遵守）：",
        `- 当前默认交付方式：${defaultProductDeliveryMode}。`,
        "- 用户明确指定本地 Markdown 或飞书云文档时，以用户本次选择覆盖默认值。",
        "- 不要为了选择交付格式单独发起澄清。提交方案时必须写入最终采用的 deliveryMode。",
        "- 方案产物完成后必须实际调用 request_spec_approval，并提交对应产物字段。",
        "- 不能只在普通回复里罗列 deliveryMode、documentUrl、specPath 或 ticketsPath。",
      ].join("\n")
    : "";

  // 发送层截断只能兜底，真正有效的是从源头约束输出长度和形态。
  const feishuOutputPolicy = [
    "飞书输出规则（必须遵守）：",
    "- 最终回复控制在 1200 个中文字符以内，先给结论，再给必要依据和下一步。",
    "- 不在回复中粘贴完整代码、长日志或整份产品文档，也不要输出 Markdown 表格。",
    "- 详细产物写入当前工作区文件，回复只提供简短摘要和文件路径。",
    "- 需要用户决策时，必须调用 request_clarification 工具，不要用大段文字列出问题。",
    "  工具调用后停止继续推断，等待用户回答。",
  ].join("\n");

  return [
    `${AGENT_OS_PROMPT_MARKER}${config.role}`,
    config.systemPrompt.trim(),
    teamContext.trim(),
    projectSkillPolicy,
    productDeliveryPolicy,
    feishuOutputPolicy,
    `当前任务：${prompt}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
