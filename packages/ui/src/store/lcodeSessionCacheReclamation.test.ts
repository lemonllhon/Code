import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultWorkspaceState } from "./lcodeSessionStoreTypes.js";
import { reclaimWorkspaceDisplayCaches } from "./lcodeSessionCacheReclamation.js";

function workspace() {
  return {
    ...createDefaultWorkspaceState("glm"),
    slashCommands: [{ name: "fixture", description: "fixture" }],
    taskListCache: [],
    configOptions: [],
    configOptionsStatus: "ready" as const,
  };
}
test("关闭后只释放派生缓存；打开的 identity 不受同路径其他桶影响", () => {
  const local = workspace(),
    remote = workspace();
  const state = { local, remote };
  const next = reclaimWorkspaceDisplayCaches(state, new Set(["remote"]));
  assert.equal(next.remote, remote);
  assert.equal(next.local!.taskListCache, null);
  assert.equal(next.local!.configOptionsStatus, "idle");
  assert.equal(next.local!.selectedSupplierKey, local.selectedSupplierKey);
  assert.equal(reclaimWorkspaceDisplayCaches(next, new Set(["remote"])), next);
});
test("草稿、运行任务、权限问答、模型切换、乐观写入和在途配置都保护", () => {
  const base = workspace();
  const guards = [
    { draftSessionId: "draft" },
    { modelSwitchPending: true },
    { composerTextInsertRequest: { requestId: 1, text: "draft" } },
    { configOptionsStatus: "loading" as const },
    { optimisticTaskListByTaskId: { t: {} } },
    { taskRuntimeByTaskId: { t: { status: "streaming", backgroundTaskControls: [] } } },
    {
      taskUiByTaskId: {
        t: {
          pendingPermissionRequests: [{}],
          pendingElicitationRequests: [],
          elicitationFormDraftsByRequestId: {},
        },
      },
    },
    {
      taskUiByTaskId: {
        t: {
          pendingPermissionRequests: [],
          pendingElicitationRequests: [],
          elicitationFormDraftsByRequestId: { x: {} },
        },
      },
    },
  ];
  for (const patch of guards) {
    const value = { ...base, ...patch } as typeof base;
    const state = { key: value };
    assert.equal(reclaimWorkspaceDisplayCaches(state, new Set()), state);
  }
});
