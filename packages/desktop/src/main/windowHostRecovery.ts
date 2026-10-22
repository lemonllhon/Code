interface HostProcess {
  once(event: "exit", listener: (code: number) => void): unknown;
  removeListener(event: "exit", listener: (code: number) => void): unknown;
}

/** 窗口拥有恢复预算；进程与 renderer 仍走既有 dom-ready 初始化链路。 */
export function createWindowHostRecovery<T extends HostProcess>(options: {
  now?: () => number;
  canRecover: (child: T) => boolean;
  isExpectedExit: (child: T) => boolean;
  recover: () => void;
  onExhausted: () => void;
  onRecoveryFailed: (error: unknown) => void;
}) {
  const now = options.now ?? Date.now;
  const failures: number[] = [];
  let current: T | undefined;
  let listener: ((code: number) => void) | undefined;
  let generation = 0;
  let pending = false;
  let exited = false;
  let disposed = false;

  const request = (manual: boolean) => {
    const child = current;
    if (disposed || pending || !exited || !child || !options.canRecover(child)) return;
    if (manual) failures.length = 0;
    const time = now();
    while (failures.length && failures[0]! <= time - 60_000) failures.shift();
    if (failures.length >= 3) {
      options.onExhausted();
      return;
    }
    if (!manual) failures.push(time);
    pending = true;
    const ticket = generation;
    // exit 的 lease/port/路由清理必须先完成；不用等待定时器猜测同步时序。
    queueMicrotask(() => {
      if (disposed || ticket !== generation) return;
      pending = false;
      if (!options.canRecover(child)) return;
      try {
        options.recover();
      } catch (error) {
        options.onRecoveryFailed(error);
      }
    });
  };

  return {
    watch(child: T) {
      if (disposed) return;
      if (current && listener) current.removeListener("exit", listener);
      current = child;
      generation++;
      pending = false;
      exited = false;
      listener = () => {
        if (current !== child || options.isExpectedExit(child)) return;
        exited = true;
        request(false);
      };
      child.once("exit", listener);
    },
    retry: () => request(true),
    dispose() {
      disposed = true;
      generation++;
      if (current && listener) current.removeListener("exit", listener);
      current = undefined;
    },
  };
}
