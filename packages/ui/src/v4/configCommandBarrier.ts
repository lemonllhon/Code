interface ConfigCommandBarrier {
  enqueue<T>(command: () => Promise<T>): Promise<T>;
  wait(): Promise<void>;
}

/**
 * 配置命令与发送命令之间的顺序屏障。
 *
 * 当前权限切换、Session 配置 CAS 与发送共享顺序；权限 ACK 前还由 Composer
 * 同步门禁阻止冻结旧 Submission，不能只等待已冻结请求进入此屏障。
 */
export function createConfigCommandBarrier(): ConfigCommandBarrier {
  let pending: Promise<void> = Promise.resolve();

  return {
    enqueue<T>(command: () => Promise<T>): Promise<T> {
      const result = pending.then(command, command);
      pending = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    wait(): Promise<void> {
      return pending;
    },
  };
}
