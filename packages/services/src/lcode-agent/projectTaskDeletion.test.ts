import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskIndexRepo } from "../session/taskIndexRepo.js";
import { createLCodeTaskIndexSyncer } from "./lcodeTaskIndexSyncer.js";
import { createLCodeTaskServiceAdapter } from "./lcodeTaskServiceAdapter.js";
import type { ILCodeAgentService } from "./lcodeAgent.js";

test("project deletion purges archived, pinned and hidden index rows only after CLI cleanup succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "lcode-project-delete-"));
  const repo = new TaskIndexRepo(join(root, "tasks.sqlite"));
  let fail = true;
  const calls: string[] = [];
  const agent = {
    cleanupWorkspaceSessions: async ({ cleanup }: { cleanup: { sessionIds?: string[] } }) => {
      calls.push(cleanup.sessionIds ? "purge" : "query");
      if (cleanup.sessionIds && fail) throw new Error("diagnostics unavailable");
      return { sessionIds: ["pinned", "archived", "hidden", "cli-only"] };
    },
    onAgentRuntimeLifecycle: () => ({ dispose() {} }),
    getWorkspaceRuntimeIdentity: () => null,
    disposeAll() {},
  } as unknown as ILCodeAgentService;
  const syncer = createLCodeTaskIndexSyncer({ agentService: agent, taskIndexRepo: repo });
  const service = createLCodeTaskServiceAdapter({
    lcodeAgentService: agent,
    taskIndexRepo: repo,
    taskIndexSyncer: syncer,
  });
  const scope = { workspacePath: "/fixture/app" };
  try {
    await assert.rejects(service.deleteWorkspaceTasks({} as never));
    assert.deepEqual(
      calls,
      [],
      "invalid RPC scope must fail before querying or purging any workspace",
    );
    for (const taskId of ["pinned", "archived", "hidden"]) {
      await repo.syncTaskMeta({
        meta: {
          ...scope,
          taskId,
          traceId: "fixture",
          title: "private",
          mode: "edit",
          createdAt: 1,
          updatedAt: 1,
        },
        pinned: taskId === "pinned",
        archived: taskId === "archived",
        deleted: taskId === "hidden",
        searchableText: "private content",
      });
    }
    await repo.syncTaskMeta({
      meta: {
        ...scope,
        workspaceIdentity: "remote-other",
        taskId: "pinned",
        traceId: "fixture",
        title: "retained",
        mode: "edit",
        createdAt: 1,
        updatedAt: 1,
      },
    });
    await assert.rejects(service.deleteWorkspaceTasks(scope), /diagnostics unavailable/);
    assert.equal((await repo.listTaskMetas(scope)).length, 2);
    fail = false;
    await service.deleteWorkspaceTasks(scope);
    assert.deepEqual(calls, ["query", "purge", "query", "purge"]);
    assert.deepEqual(await repo.listTaskMetas(scope), []);
    const tombstones = await repo.listTaskMetas({ ...scope, includeDeleted: true });
    assert.equal(tombstones.length, 4);
    assert.ok(tombstones.every((task) => task.title === ""));
    assert.equal(
      (await repo.listTaskMetas({ ...scope, workspaceIdentity: "remote-other" }))[0]!.title,
      "retained",
    );
  } finally {
    repo.close();
    await rm(root, { recursive: true, force: true });
  }
});
