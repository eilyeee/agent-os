/** 给「可能永远不返回」的异步调用加一道时限。不依赖任何消息平台。 */

/**
 * 到点就不再等，但**不会取消**底层操作——它可能仍然成功。
 * 所以只适合「等不到也能往下走」的调用：刷新卡片（下一次刷新会覆盖）、
 * 发通知（最坏丢一条消息），不适合「必须知道到底做没做成」的写操作。
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = "调用",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    // 这里**不能** unref：护栏要生效的场景正是「所有事都挂在这个调用上」，
    // 那时事件循环已经空了，unref 的计时器不但不会触发，还会让进程直接退出。
    // 改成竞速一结束就 clearTimeout，同样不会拖住进程。
    timer = setTimeout(
      () => reject(new Error(`${label}超时（${ms} 毫秒未返回）`)),
      ms,
    );
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
