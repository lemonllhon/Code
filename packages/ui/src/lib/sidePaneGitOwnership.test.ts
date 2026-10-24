import assert from "node:assert/strict";
import test from "node:test";
import {
  activateGitSidePane,
  closeGitSidePane,
  closeVisibleSidePaneTabs,
  getVisibleSidePaneTabs,
  resolveSidePaneScopeState,
  restoreSidePaneTab,
  stampSidePaneTabsOwnership,
  toggleGitSidePane,
} from "./workspaceSidePane.js";

test("同项目各会话分别复用自己的 Git，关闭 B 不影响 A", () => {
  const a = stampSidePaneTabsOwnership(activateGitSidePane(null, "review", "a"), {
    workspaceKey: "/repo",
    ownerTaskId: "a",
  })!;
  const aId = a.activeTabId;
  const b = stampSidePaneTabsOwnership(activateGitSidePane(a, "changes", "b"), {
    workspaceKey: "/repo",
    ownerTaskId: "b",
  })!;
  assert.notEqual(b.activeTabId, aId);
  assert.equal(b.tabs.length, 2);
  assert.deepEqual(
    getVisibleSidePaneTabs(b.tabs, { workspaceKey: "/repo", ownerTaskId: "a" }).map(
      (tab) => tab.id,
    ),
    [aId],
  );
  const reopenedA = activateGitSidePane(b, "graph", "a");
  assert.equal(reopenedA.activeTabId, aId);
  assert.equal(reopenedA.tabs.length, 2);
  assert.equal(closeGitSidePane(b)?.tabs[0]?.id, aId);
  assert.equal(closeVisibleSidePaneTabs(b, "b")?.tabs[0]?.id, aId);
  assert.equal(toggleGitSidePane(a, "b")?.tabs.length, 2, "切换 B 不能 toggle 关闭 A 的 Git");
});

test("草稿与真实会话隔离，最近关闭不能重复创建当前会话的 Git", () => {
  const draft = activateGitSidePane(null, "review", null);
  const a = activateGitSidePane(draft, "changes", "a");
  assert.equal(a.tabs.length, 2);
  const old = a.tabs.find((tab) => tab.id === a.activeTabId)!;
  const replacement = activateGitSidePane(closeGitSidePane(a), "changes", "a");
  const restored = restoreSidePaneTab(replacement, old);
  assert.equal(restored.tabs.length, 2);
  assert.equal(restored.activeTabId, replacement.activeTabId);
  assert.notEqual(restored.activeTabId, old.id);
  assert.deepEqual(
    getVisibleSidePaneTabs(restored.tabs, { workspaceKey: null, ownerTaskId: null }).map(
      (tab) => tab.id,
    ),
    [draft.activeTabId],
  );
});

test("旧单例 Git 保留 id 并认领到明确会话，新会话另建标签", () => {
  const legacy = { tabs: [{ id: "git", type: "git" as const }], activeTabId: "git" };
  const migrated = resolveSidePaneScopeState(legacy, {
    workspaceKey: "/repo",
    ownerTaskId: "a",
  }).sidePaneState!;
  assert.equal(migrated.tabs[0]?.id, "git");
  assert.equal(migrated.tabs[0]?.ownerTaskId, "a");
  assert.equal(activateGitSidePane(migrated, "review", "a").activeTabId, "git");
  assert.notEqual(activateGitSidePane(migrated, "review", "b").activeTabId, "git");
});
