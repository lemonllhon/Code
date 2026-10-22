import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IGitService } from "@lcode/services";
import type { GitChangeSourceId, GitDiffResult } from "@lcode/shared";
import type { GitPaneFileChange } from "@/hooks/useGitRepository.js";
import { getDiffCacheKey, getErrorMessage } from "@/GitPane/helpers.js";
import { logger } from "@/logger.js";

interface DiffEntry {
  revision: number;
  loading: boolean;
  diff: GitDiffResult | null;
}
const EMPTY_ENTRIES: Record<string, DiffEntry> = {};

function sameDiff(left: GitDiffResult | null | undefined, right: GitDiffResult): boolean {
  return Boolean(
    left &&
    left.path === right.path &&
    left.availability === right.availability &&
    left.patch === right.patch &&
    left.beforeContent === right.beforeContent &&
    left.afterContent === right.afterContent &&
    left.summary === right.summary,
  );
}

/** 只拥有 Diff 展示缓存；revision 触发核对，不清空已显示内容或充当写入依据。 */
export function useGitPaneDiffs({
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  gitService,
  revision,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  gitService: IGitService;
  revision: number;
}) {
  const identity = workspaceIdentity?.trim() || undefined;
  const scope = useMemo(
    () => ({
      request: { workspacePath, workspaceIdentity: identity },
      gitService,
      workspaceRemoteSessionId,
    }),
    [workspacePath, identity, workspaceRemoteSessionId, gitService],
  );
  const latestScope = useRef<typeof scope | null>(scope);
  latestScope.current = scope;
  const pending = useMemo(() => new Set<string>(), [scope]);
  const [cache, setCache] = useState<{ scope: typeof scope; entries: Record<string, DiffEntry> }>({
    scope,
    entries: EMPTY_ENTRIES,
  });
  // 同路径切 Host 时，旧缓存必须在 render 即不可见，不能等 effect 清空后才隔离。
  const entries = cache.scope === scope ? cache.entries : EMPTY_ENTRIES;
  useEffect(() => {
    latestScope.current = scope;
    return () => {
      latestScope.current = null;
    };
  }, [scope]);

  const load = useCallback(
    (change: GitPaneFileChange, sourceId: GitChangeSourceId) => {
      if (latestScope.current !== scope || sourceId === "last-turn" || change.diff) return;
      const key = getDiffCacheKey(sourceId, change.path);
      if (pending.has(key) || entries[key]?.revision === revision) return;
      pending.add(key);
      setCache((current) => {
        const values = current.scope === scope ? current.entries : EMPTY_ENTRIES;
        return {
          scope,
          entries: {
            ...values,
            [key]: {
              revision,
              loading: true,
              diff: values[key]?.diff ?? null,
            },
          },
        };
      });
      void (async () => {
        let diff: GitDiffResult;
        try {
          diff = await gitService.getDiff({ ...scope.request, path: change.path, sourceId });
        } catch (error) {
          if (latestScope.current !== scope) return;
          const message = getErrorMessage(error);
          logger.warn("[GitPane] 读取文件 diff 失败", {
            workspacePath,
            sourceId,
            path: change.path,
            error: message,
          });
          diff = {
            path: change.path,
            availability: "unavailable",
            patch: null,
            beforeContent: null,
            afterContent: null,
            summary: message,
          };
        }
        if (latestScope.current !== scope) return;
        logger.debug("[GitPane] diff 已加载", {
          workspacePath,
          sourceId,
          path: change.path,
          availability: diff.availability,
          beforeChars: diff.beforeContent?.length ?? 0,
          afterChars: diff.afterContent?.length ?? 0,
        });
        // 修复依据：原每轮清缓存会卸载 Diff 并并发重读。保留旧内容，一个文件只读一次；
        // 完成后若 revision 已前进，展开/搜索 effect 按最新 revision 再核对一次，不饿死结果。
        pending.delete(key);
        setCache((current) => {
          const values = current.scope === scope ? current.entries : EMPTY_ENTRIES;
          const previous = values[key]?.diff;
          return {
            scope,
            entries: {
              ...values,
              [key]: {
                revision,
                loading: false,
                diff: sameDiff(previous, diff) ? previous! : diff,
              },
            },
          };
        });
      })();
    },
    [scope, pending, entries, revision, gitService, workspacePath],
  );
  return { entries, load };
}
