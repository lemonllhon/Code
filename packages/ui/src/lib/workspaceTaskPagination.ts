import "@/lib/taskQueryCache.js";

export const WORKSPACE_TASK_PAGE_SIZE = 5;

export type WorkspaceTaskVisibleLimitByKey = Record<string, number>;

export function resolveWorkspaceTaskVisibleLimit(
  limits: Readonly<WorkspaceTaskVisibleLimitByKey>,
  workspaceKey: string,
  pageSize = WORKSPACE_TASK_PAGE_SIZE,
): number {
  const storedLimit = limits[workspaceKey];
  return typeof storedLimit === "number" && Number.isFinite(storedLimit)
    ? Math.max(pageSize, Math.floor(storedLimit))
    : pageSize;
}
