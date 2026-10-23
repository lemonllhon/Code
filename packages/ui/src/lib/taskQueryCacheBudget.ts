import type { LCodeTaskMeta } from "@lcode/shared";
import type { CachedTaskListResult } from "./taskQueryCache.js";
import { getTaskListAttention, isTaskListRowActive } from "../v4/taskListRowActivity.js";

export interface ActiveQueryLease {
  references: number;
  generation: number;
  workspaceKeys: readonly string[];
}

/** 纯预算计算；引用和 overlay 保护来自同一 Query store 事务，不读取服务或其它 store。 */
export function pruneTaskQueryCache<T extends LCodeTaskMeta>(state: {
  resultsByQueryKey: Record<string, CachedTaskListResult>;
  taskMetaByEntityKey: Record<string, T>;
  taskUnreadOverlayByEntityKey: Record<string, number | null>;
  activeQueries: Record<string, ActiveQueryLease>;
}) {
  const inactive = Object.entries(state.resultsByQueryKey)
    .reverse()
    .filter(([key]) => !state.activeQueries[key])
    .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt);
  let results = state.resultsByQueryKey;
  if (inactive.length > 40) {
    results = { ...results };
    for (const [key] of inactive.slice(40)) delete results[key];
  }
  const referenced = new Set(
    Object.values(results).flatMap((result) => [
      ...result.taskKeys,
      ...(result.unreadTaskKeys ?? []),
    ]),
  );
  const unreferenced = Object.entries(state.taskMetaByEntityKey)
    .filter(
      ([key, task]) =>
        !referenced.has(key) &&
        !Object.hasOwn(state.taskUnreadOverlayByEntityKey, key) &&
        !isTaskListRowActive(task) &&
        !getTaskListAttention(task),
    )
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  let metas = state.taskMetaByEntityKey;
  if (unreferenced.length > 500) {
    metas = { ...metas };
    for (const [key] of unreferenced.slice(500)) delete metas[key];
  }
  return { resultsByQueryKey: results, taskMetaByEntityKey: metas };
}
