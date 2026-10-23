import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { WorkerPoolContext, type WorkerInitializationRenderOptions } from "@pierre/diffs/react";
import { WorkerPoolManager } from "@pierre/diffs/worker";
import { createDiffsWorkerHighlighterOptions } from "@/lib/diffsHighlighterEngine.js";
import { DiffsWorkerPoolOwner } from "@/lib/diffsWorkerPoolOwner.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";
import { logger } from "@/logger.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { LeaseContext } from "@/lib/diffsWorkerPoolContext.js";
import { useLCodeStore } from "@/store/StoreProvider.js";

function createDiffsWorker(): Worker {
  return new Worker(new URL("../workers/diffs.worker.ts", import.meta.url), {
    type: "module",
    name: "lcode-diffs-worker",
  });
}

export function DiffsWorkerPoolProvider({ children }: { children: ReactNode }) {
  const settings = useLCodeStore(
    (state) => state.codePreviewSettings ?? DEFAULT_CODE_PREVIEW_SETTINGS,
  );
  const options = useRef<WorkerInitializationRenderOptions>({});
  options.current = createDiffsWorkerHighlighterOptions({
    lightTheme: settings.lightTheme,
    darkTheme: settings.darkTheme,
  });
  const [owner] = useState(
    () =>
      new DiffsWorkerPoolOwner(
        () =>
          new WorkerPoolManager(
            { workerFactory: createDiffsWorker, poolSize: 1, totalASTLRUCacheSize: 20 },
            options.current ?? {},
          ),
        (error) => logger.warn("[DiffsWorkerPool] 初始化失败，沿用代码查看器回退", error),
      ),
  );
  const { manager } = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  useEffect(() => {
    if (!manager) return;
    void manager.setRenderOptions(options.current ?? {}).catch((error: unknown) => {
      // 旧池释放时 setRenderOptions 同样可能被取消，不把它记为新代故障。
      if (owner.getSnapshot().manager === manager)
        logger.warn("[DiffsWorkerPool] 同步主题失败", error);
    });
  }, [manager, owner, settings.lightTheme, settings.darkTheme]);
  useEffect(() => {
    const registration = uiMemoryDiagnosticsRegistry.register("diffPool", () => {
      const snapshot = owner.getSnapshot();
      const stats = snapshot.manager?.getStats();
      return {
        consumers: snapshot.consumers,
        generation: snapshot.generation,
        workers: stats?.totalWorkers ?? 0,
        queued: stats?.queuedTasks ?? 0,
        active: stats?.activeTasks ?? 0,
        fileCache: stats?.fileCacheSize ?? 0,
        diffCache: stats?.diffCacheSize ?? 0,
      };
    });
    return () => registration.dispose();
  }, [owner]);
  const canUse = typeof window !== "undefined" && typeof Worker !== "undefined";
  return (
    <LeaseContext.Provider value={canUse ? owner : undefined}>
      <WorkerPoolContext.Provider value={manager}>{children}</WorkerPoolContext.Provider>
    </LeaseContext.Provider>
  );
}
