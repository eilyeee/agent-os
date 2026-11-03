/** 工作目录的解析与校验。路径只在这里转换成绝对路径。 */
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { BotConfig } from "./bot-registry.js";

/**
 * 相对路径从 baseDirectory 开始计算：
 * 配置里的相对路径以 Agent OS 当前目录为基准，
 * 话题里的 /cd 则以该话题当前目录为基准，体验和终端里的 cd 一致。
 */
export function resolveWorkspacePath(
  input: string,
  baseDirectory = process.cwd(),
): string {
  const value = input.trim();
  if (!value) throw new Error("工作目录不能为空");
  return isAbsolute(value) ? resolve(value) : resolve(baseDirectory, value);
}

export async function ensureWorkspaceDirectory(path: string): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new Error(`工作目录不存在: ${path}`);
  }
  if (!info.isDirectory()) throw new Error(`工作目录不是文件夹: ${path}`);
}

export async function ensureAllowedWorkspace(
  path: string,
  config: Pick<BotConfig, "workspaceDir" | "allowedWorkspaceDirs">,
): Promise<string> {
  await ensureWorkspaceDirectory(path);
  const target = await realpath(path);
  const roots = config.allowedWorkspaceDirs ?? [config.workspaceDir];
  for (const root of roots) {
    // 先解符号链接再比较：目录前缀比较会放过同名前缀目录与指向外部的链接。
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(root);
    } catch {
      // 一个项目被移走不能锁死名单里的其他项目；不可读取的根不会授权任何目录。
      continue;
    }
    const offset = relative(canonicalRoot, target);
    if (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset)) return target;
  }
  throw new Error("工作目录不在允许范围内，请让管理员检查 allowedWorkspaceDirs 配置。");
}
