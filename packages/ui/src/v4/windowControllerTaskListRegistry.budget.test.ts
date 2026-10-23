import assert from "node:assert/strict";
import test from "node:test";
import type {
  IWindowControllerService,
  LCodeTaskListQuery,
  WindowHostControllerTaskListResult,
} from "@lcode/services";
import { getWindowControllerTaskListRegistry } from "./windowControllerTaskListRegistry.js";

const version = { controllerRevision: 0, taskListVersionSignature: "v1" };
const query: LCodeTaskListQuery = {
  workspaceScopes: [{ workspacePath: "/fixture" }],
  kind: "active",
  sortBy: "updated",
};
const result = {} as WindowHostControllerTaskListResult;

test("settled Controller queries are LRU bounded; in-flight requests stay single-flight", async () => {
  const calls: string[] = [];
  const blocked = Promise.withResolvers<WindowHostControllerTaskListResult>();
  const controller = {
    listTaskList: async (q: LCodeTaskListQuery) => {
      calls.push(String(q.limit));
      return q.limit === -1 ? blocked.promise : result;
    },
  } as IWindowControllerService;
  const registry = getWindowControllerTaskListRegistry(controller);
  const pendingQuery = { ...query, limit: -1 };
  const pending = registry.list("pending", version, pendingQuery);
  const first = registry.list("old", version, query);
  await first;
  for (let i = 0; i < 80; i++) await registry.list(String(i), version, { ...query, limit: i + 1 });
  assert.equal(registry.list("pending", version, pendingQuery), pending);
  const count = calls.length;
  await registry.list("79", version, query);
  assert.equal(calls.length, count, "hot result still reused");
  assert.notEqual(registry.list("old", version, query), first, "cold completed query evicted");
  blocked.resolve(result);
  await pending;
});

test("Controller failed requests retry and late old failures do not evict the new source", async () => {
  const old = Promise.withResolvers<WindowHostControllerTaskListResult>();
  let calls = 0;
  const controller = {
    listTaskList: () => (++calls === 1 ? old.promise : Promise.resolve(result)),
  } as unknown as IWindowControllerService;
  const registry = getWindowControllerTaskListRegistry(controller);
  const previous = registry.list("same", version, query);
  const next = registry.list(
    "same",
    { ...version, workspaceSourceGenerationSignature: "new-source" },
    query,
  );
  old.reject(new Error("old failed"));
  await assert.rejects(previous);
  await next;
  assert.equal(
    registry.list("same", { ...version, workspaceSourceGenerationSignature: "new-source" }, query),
    next,
  );
  assert.equal(calls, 2);
});
