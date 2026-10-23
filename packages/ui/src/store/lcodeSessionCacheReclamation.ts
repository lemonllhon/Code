import type { WorkspaceLCodeUIState } from "./lcodeSessionStoreTypes.js";

export function isWorkspaceCacheProtected(state: WorkspaceLCodeUIState): boolean {
  return !!(
    state.draftSessionId ||
    state.groupedDraftTask ||
    state.composerTextInsertRequest ||
    state.modelSwitchPending ||
    state.configOptionsStatus === "loading" ||
    Object.keys(state.optimisticTaskListByTaskId).length ||
    Object.keys(state.promotedGroupedDraftTaskByTaskId).length ||
    ["creating", "restoring", "streaming"].includes(state.draftRuntime.status) ||
    Object.values(state.taskConfigOptionsStatusByTaskId).some((status) => status === "loading") ||
    Object.values(state.taskRuntimeByTaskId).some(
      (task) =>
        ["creating", "restoring", "streaming"].includes(task.status) ||
        task.backgroundTaskControls.length > 0 ||
        task.activeInputId,
    ) ||
    Object.values(state.taskUiByTaskId).some(
      (ui) =>
        ui.permissionRequest ||
        ui.elicitationRequest ||
        ui.pendingPermissionRequests.length ||
        ui.pendingElicitationRequests.length ||
        Object.keys(ui.elicitationFormDraftsByRequestId).length,
    )
  );
}

/** 只回收权威服务可重建的显示数据；不删除桶、composer、附件或执行状态。 */
export function reclaimWorkspaceDisplayCaches(
  workspaces: Record<string, WorkspaceLCodeUIState>,
  openKeys: ReadonlySet<string>,
) {
  let next = workspaces;
  for (const [key, state] of Object.entries(workspaces)) {
    if (openKeys.has(key) || isWorkspaceCacheProtected(state)) continue;
    if (
      state.configOptions === null &&
      state.configOptionsStatus === "idle" &&
      state.slashCommands.length === 0 &&
      state.taskListCache === null &&
      Object.keys(state.taskConfigOptionsByTaskId).length === 0 &&
      Object.keys(state.taskConfigOptionsStatusByTaskId).length === 0
    )
      continue;
    // 关闭标签不等于任务结束；运行事实和人工介入状态始终保留原 owner。
    if (next === workspaces) next = { ...workspaces };
    next[key] = {
      ...state,
      configOptions: null,
      configOptionsStatus: "idle",
      slashCommands: [],
      taskListCache: null,
      taskConfigOptionsByTaskId: {},
      taskConfigOptionsStatusByTaskId: {},
    };
  }
  return next;
}
