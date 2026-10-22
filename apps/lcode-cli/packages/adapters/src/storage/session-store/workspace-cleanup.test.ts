import assert from "node:assert/strict";
import test from "node:test";
import type { SessionId, ProjectId, MessageId } from "@lcode/contracts";
import { createSqliteSessionStore } from "../session-store.js";

test("workspace cleanup permanently deletes all matching chats and replays IDs, isolating same-path origins", async () => {
  const store = createSqliteSessionStore({ dbPath: ":memory:" });
  try {
    for (const [id, workspaceID] of [
      ["visible", "/fixture/app"],
      ["hidden", "/fixture/app"],
      ["remote", "remote-fixture"],
    ]) {
      await store.createSession({
        id: id as SessionId,
        projectID: "app" as ProjectId,
        slug: id!,
        title: id!,
        directory: "/fixture/app",
        path: "/fixture/app",
        workspaceID: workspaceID as never,
        version: "test",
      });
      await store.saveMessage({
        id: `message-${id}` as MessageId,
        sessionID: id as SessionId,
        role: "user",
        time: { created: 1 },
        agent: "agent",
      });
    }
    const scope = { workspacePath: "/fixture/app" };
    const matching = await store.workspaceCleanup(scope);
    assert.deepEqual(matching.sessionIds.sort(), ["hidden", "visible"]);
    await assert.rejects(
      store.workspaceCleanup({ ...scope, sessionIds: ["visible"] }),
      /set changed/,
    );
    await assert.rejects(
      store.workspaceCleanup({ ...scope, sessionIds: ["remote", ...matching.sessionIds] }),
      /outside/,
    );
    assert.ok(await store.getSession("visible" as SessionId));
    await store.workspaceCleanup({ ...scope, sessionIds: matching.sessionIds });
    assert.equal(await store.getSession("visible" as SessionId), null);
    assert.equal(await store.getSession("hidden" as SessionId), null);
    assert.equal(store.debugCounts("visible" as SessionId).messages, 0);
    assert.equal(store.debugCounts("hidden" as SessionId).messages, 0);
    assert.ok(await store.getSession("remote" as SessionId));
    // 正文已删、诊断尚未确认时重新查询仍取得原 ID，不能因空库而漏掉私有诊断文件。
    assert.deepEqual(await store.workspaceCleanup(scope), matching);
    assert.deepEqual(
      await store.workspaceCleanup({ ...scope, sessionIds: matching.sessionIds }),
      matching,
    );
  } finally {
    store.close();
  }
});
