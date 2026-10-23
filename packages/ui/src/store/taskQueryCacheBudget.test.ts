import assert from "node:assert/strict";
import test from "node:test";
import { useTaskQueryCacheStore as store } from "./taskQueryCacheStore.js";
import { attachTaskListRowActivity } from "../v4/taskListRowActivity.js";

const descriptor = {
  kind: "workspace" as const,
  sortBy: "updated" as const,
  search: "",
  expanded: false,
  visibleLimit: 20,
  workspaceKeys: ["fixture"],
};
const task = (id: string) => ({
  taskId: id,
  workspacePath: "/fixture",
  workspaceIdentity: "fixture",
  title: id,
  traceId: "synthetic",
  mode: "auto" as const,
  createdAt: 1,
  updatedAt: 1,
  status: "completed" as const,
});
function write(key: string, id = key) {
  store
    .getState()
    .setQueryResult({ queryKey: key, descriptor, items: [task(id)], total: 1, hasMore: false });
}
test("查询和无引用 meta 有界，活跃查询与 unread overlay 不驱逐", () => {
  store.getState().clearAll();
  const release = store.getState().retainQuery("active");
  write("active");
  store.getState().setTaskUnreadOverlay(task("overlay"), 2);
  store.getState().upsertTaskMeta(task("overlay"));
  for (let i = 0; i < 650; i++) write("history-" + i);
  const state = store.getState();
  assert.ok(state.resultsByQueryKey.active);
  assert.ok(Object.keys(state.resultsByQueryKey).length <= 41);
  assert.ok(Object.keys(state.taskMetaByEntityKey).length <= 542);
  assert.ok(state.taskMetaByEntityKey["fixture::overlay"]);
  release();
  release();
  assert.equal(Object.keys(store.getState().activeQueries).length, 0);
});
test("释放再进入和 clearAll 后拒绝旧代 batch，不回写 meta/overlay", () => {
  store.getState().clearAll();
  const a = store.getState().retainQuery("key");
  const generation = store.getState().activeQueries.key!.generation;
  a();
  const b = store.getState().retainQuery("key");
  const entry = {
    queryKey: "key",
    descriptor,
    items: [task("stale")],
    total: 1,
    hasMore: false,
    expectedQueryGeneration: generation,
  };
  store.getState().setQueryResults([entry]);
  assert.equal(store.getState().taskMetaByEntityKey["fixture::stale"], undefined);
  const next = store.getState().activeQueries.key!.generation;
  store.getState().clearAll();
  store.getState().setQueryResults([{ ...entry, expectedQueryGeneration: next }]);
  assert.equal(store.getState().resultsByQueryKey.key, undefined);
  b();
});
test("运行和权限等待 meta 在无引用预算之外保护", () => {
  store.getState().clearAll();
  store.getState().upsertTaskMeta(
    attachTaskListRowActivity(task("running"), {
      phase: "running",
      lastActivityAt: 1,
      hasBackgroundWork: false,
    }),
  );
  for (let i = 0; i < 510; i++) store.getState().upsertTaskMeta(task("past-" + i));
  assert.ok(store.getState().taskMetaByEntityKey["fixture::running"]);
});

test("硬失效旋转活跃查询代次，旧 RPC 不能复活同 identity 的缓存", () => {
  store.getState().clearAll();
  const release = store.getState().retainQuery("workspaces=fixture");
  write("workspaces=fixture");
  const generation = store.getState().activeQueries["workspaces=fixture"]!.generation;
  store.getState().invalidateWorkspaceKeys(["fixture"]);
  store.getState().setQueryResults([
    {
      queryKey: "workspaces=fixture",
      descriptor,
      items: [task("late")],
      total: 1,
      hasMore: false,
      expectedQueryGeneration: generation,
    },
  ]);
  assert.equal(store.getState().taskMetaByEntityKey["fixture::late"], undefined);
  release();
});

test("未返回结果的活跃查询按精确 scope 失效，路径前缀相同也不串台", () => {
  store.getState().clearAll();
  const a = store.getState().retainQuery("workspaces=fixture", ["fixture"]);
  const b = store.getState().retainQuery("workspaces=fixture-other", ["fixture-other"]);
  const old = store.getState().activeQueries["workspaces=fixture-other"]!.generation;
  store.getState().invalidateWorkspaceKeys(["fixture"]);
  assert.equal(store.getState().activeQueries["workspaces=fixture-other"]!.generation, old);
  a();
  b();
});
