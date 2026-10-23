/** 只负责退出资格，业务在途与调度需求仍由 Scheduler/Repo 拥有。 */
export function createSchedulerIdleExit(deps: {
  hasDemand: () => Promise<boolean>;
  isBusy: () => boolean;
  exit: () => void;
  onError: (error: unknown) => void;
}) {
  let revision = 0;
  let checking = false;
  let exited = false;
  return {
    invalidate() {
      revision++;
    },
    async check() {
      if (exited || checking || deps.isBusy()) return;
      checking = true;
      const observed = revision;
      try {
        const needed = await deps.hasDemand();
        // 查询期间新 tick/结算/wake 到达，原空结果已无资格结束进程。
        if (!needed && observed === revision && !deps.isBusy()) {
          exited = true;
          deps.exit();
        }
      } catch (error) {
        deps.onError(error);
      } finally {
        checking = false;
      }
    },
  };
}
