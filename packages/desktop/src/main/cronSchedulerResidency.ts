/** Main 只拥有物理进程；需求从 Host 查回，调度/认领规则始终归 Repo 与 Scheduler。 */
interface ResidentProcess {
  wake: (reason: string) => void;
  dispose: () => Promise<void>;
}

export function createCronSchedulerResidency<T extends ResidentProcess>(deps: {
  readDemand: () => Promise<boolean | null>;
  spawn: (onExit: (idle?: boolean) => void) => T;
  onError: (error: unknown) => void;
}) {
  let current: T | null = null;
  let started = false;
  let disposed = false;
  let revision = 0;
  let checkedRevision = -1;
  let checking = false;
  // 一次失效最多以 unknown 启动一次；空闲进程退出后查询仍失败时不能循环 fork。
  let unknownStartedRevision = -1;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleRestart(): void {
    if (disposed || restartTimer) return;
    // 崩溃/创建失败才退避；正常需求变化仍立即观察，不用延时掩盖退出同步。
    restartTimer = setTimeout(() => {
      restartTimer = null;
      checkedRevision = -1;
      unknownStartedRevision = -1;
      void reconcile();
    }, 5_000);
    restartTimer.unref();
  }

  async function reconcile(): Promise<void> {
    if (!started || disposed || checking) return;
    checking = true;
    try {
      while (!disposed && checkedRevision !== revision) {
        const observed = revision;
        let needed: boolean | null;
        let unknown = false;
        try {
          needed = await deps.readDemand();
        } catch (error) {
          deps.onError(error);
          needed = true;
          unknown = true;
        }
        if (disposed) return;
        if (observed !== revision) continue;
        checkedRevision = observed;
        if (needed === null) continue;
        if (current) {
          current.wake("demand-changed");
        } else if (needed && (!unknown || unknownStartedRevision !== observed)) {
          if (unknown) unknownStartedRevision = observed;
          let child: T;
          try {
            child = deps.spawn((idle = true) => {
              if (current !== child) return;
              // 只有真实 exit 能释放 owner。再查一次，补上退出前最后一瞬间的新写入。
              current = null;
              checkedRevision = -1;
              if (disposed) return;
              if (idle) void reconcile();
              else scheduleRestart();
            });
            current = child;
          } catch (error) {
            deps.onError(error);
            scheduleRestart();
          }
        }
      }
    } finally {
      checking = false;
    }
  }

  return {
    get current(): T | null {
      return current;
    },
    start() {
      started = true;
      revision++;
      void reconcile();
    },
    invalidate() {
      revision++;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      void reconcile();
    },
    async dispose() {
      disposed = true;
      if (restartTimer) clearTimeout(restartTimer);
      await current?.dispose();
    },
  };
}
