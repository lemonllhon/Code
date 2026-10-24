import assert from "node:assert/strict";
import test from "node:test";
import {
  sidePaneToolWindowKey,
  toolWindowScopeKey,
  toolWindowWorkspaceKey,
} from "./sidePaneToolWindow.js";
import {
  readTaskSidePaneMemoryState,
  retainTaskSidePaneMemory,
  saveTaskSidePaneMemoryState,
} from "./taskSidePaneMemory.js";

test("相同路径的不同远程项目和会话不能接管彼此的工具窗口", () => {
  const a = {
    workspacePath: "/repo",
    workspaceIdentity: "  owner-a  ",
    sessionId: "chat-1",
    projectName: "A",
    sessionTitle: "One",
  };
  const b = { ...a, workspaceIdentity: "owner-b" };
  assert.equal(toolWindowWorkspaceKey(a), "owner-a");
  assert.notEqual(
    sidePaneToolWindowKey(toolWindowWorkspaceKey(a), "git"),
    sidePaneToolWindowKey(toolWindowWorkspaceKey(b), "git"),
  );
  assert.notEqual(toolWindowScopeKey(a), toolWindowScopeKey({ ...a, sessionId: "chat-2" }));
  assert.equal(toolWindowWorkspaceKey({ ...a, workspaceIdentity: " " }), "/repo");
});

test("独立窗口的记忆 lease 可重入并幂等释放，LRU 不淘汰仍被窗口使用的工作区", () => {
  const key = "/retained-tool-window";
  saveTaskSidePaneMemoryState(key, {
    sidePaneState: { tabs: [{ id: "git", type: "git" }], activeTabId: "git" },
  });
  const one = retainTaskSidePaneMemory(key);
  const two = retainTaskSidePaneMemory(key);
  one();
  one();
  for (let i = 0; i < 60; i++)
    saveTaskSidePaneMemoryState(`/other-${i}`, { isSidePaneCollapsed: false });
  assert.equal(readTaskSidePaneMemoryState(key).sidePaneState?.activeTabId, "git");
  two();
  for (let i = 60; i < 120; i++)
    saveTaskSidePaneMemoryState(`/other-${i}`, { isSidePaneCollapsed: false });
  assert.equal(readTaskSidePaneMemoryState(key).sidePaneState, null);
});
