import type { GitDiffResult, GitRefreshResult } from "@lcode/shared";

/** 确定性读取屏障；只影响测试服务，不读用户仓库。 */
export function createFileRefreshProbe(
  root: string,
  read: () => GitRefreshResult,
  platform: string,
) {
  const watchers = new Map<string, (event: { dirPath: string }) => void>();
  let watcherCount = 0;
  let refreshCount = 0;
  let refreshing = 0;
  let maxRefreshing = 0;
  let holdRefresh = false;
  let releaseRefresh: (() => void) | undefined;
  let diffCount = 0;
  let diffing = 0;
  let maxDiffing = 0;
  let holdDiff = false;
  let releaseDiff: (() => void) | undefined;
  let diffContent = "after";
  let failDiff = false;
  return {
    refresh: async () => {
      refreshCount++;
      refreshing++;
      maxRefreshing = Math.max(maxRefreshing, refreshing);
      const result = structuredClone(read());
      if (holdRefresh)
        await new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        });
      refreshing--;
      return result;
    },
    getDiff: async ({ path }: { path: string }): Promise<GitDiffResult> => {
      diffCount++;
      diffing++;
      maxDiffing = Math.max(maxDiffing, diffing);
      const content = diffContent;
      const failure = failDiff;
      if (holdDiff)
        await new Promise<void>((resolve) => {
          releaseDiff = resolve;
        });
      diffing--;
      if (failure) throw new Error("fixture diff failed");
      return {
        path,
        availability: "patch",
        patch: "",
        beforeContent: "before",
        afterContent: content,
        summary: "",
      };
    },
    services: {
      systemService: { info: async () => ({ platform }) },
      fileWatcherService: {
        watch: async () => ({ id: String(++watcherCount) }),
        unwatch: async ({ id }: { id: string }) => {
          watchers.delete(id);
        },
        onDynamicChange: (id: string) => (listener: (event: { dirPath: string }) => void) => {
          watchers.set(id, listener);
          return {
            dispose: () => {
              watchers.delete(id);
            },
          };
        },
      },
    },
    controls: {
      holdRefresh: () => {
        holdRefresh = true;
      },
      releaseRefresh: () => {
        holdRefresh = false;
        releaseRefresh?.();
      },
      emit: () => {
        for (const notify of watchers.values()) notify({ dirPath: root });
      },
      holdDiff: () => {
        holdDiff = true;
      },
      unholdDiff: () => {
        holdDiff = false;
      },
      releaseDiff: () => {
        holdDiff = false;
        releaseDiff?.();
      },
      editDiff: (content: string) => {
        diffContent = content;
      },
      failDiff: (value: boolean) => {
        failDiff = value;
      },
    },
    metrics: () => ({
      refreshCount,
      refreshing,
      maxRefreshing,
      diffCount,
      diffing,
      maxDiffing,
      watcherCount,
      watchers: watchers.size,
    }),
  };
}
