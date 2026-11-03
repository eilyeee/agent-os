/** 一轮跑完，工作区到底动没动——看结果，不看它用了什么工具。 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

/**
 * 为什么不数「用了几次写文件的工具」：
 * 引擎完全可以用 `Bash` 跑一段 python 去改文件，真机上它就是这么干的（一轮 6 次）；
 * 子 Agent 改的文件更是压根不出现在主轮次的事件流里。
 * 按工具名判断等于只认那几个名字，而写文件有的是别的写法——
 * 「改了文件却没人验证」这个警告因此对一大类情况完全失效。
 *
 * 改成前后各取一次工作区指纹再比：不关心你怎么改的，只关心到底改没改。
 */
const GIT_TIMEOUT_MS = 10_000;

/**
 * 工作区当前状态的指纹。不是 git 仓库、或者 git 不可用时返回 undefined——
 * 那是「不知道」，不是「没改过」，调用方要能分清这两者。
 */
export function workspaceFingerprint(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      // --porcelain 的输出对「新增 / 修改 / 删除 / 未跟踪」都敏感，
      // 而且格式稳定，正是拿来做指纹的东西。
      ["status", "--porcelain", "--untracked-files=all"],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        resolve(createHash("sha256").update(stdout).digest("hex").slice(0, 16));
      },
    );
    // 取指纹失败绝不能拖住一轮任务：拿不到就当「不知道」。
    child.on("error", () => resolve(undefined));
  });
}

/**
 * 前后两次指纹比一比。任一侧拿不到就返回 undefined（不知道），
 * 而不是 false（没改过）——把「不知道」说成「没改过」，
 * 会让「未经验证」的警告在最该响的时候沉默。
 */
export function workspaceChanged(
  before: string | undefined,
  after: string | undefined,
): boolean | undefined {
  if (before === undefined || after === undefined) return undefined;
  return before !== after;
}
