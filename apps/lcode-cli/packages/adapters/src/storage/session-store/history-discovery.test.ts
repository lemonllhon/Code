import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { HISTORY_DISCOVERY_TOTAL_BYTES } from "@lcode/contracts";
import type { MessageId, PartId, ProjectId, SessionId } from "@lcode/contracts";
import { createSqliteSessionStore } from "../session-store.js";

test(
  "Windows discovery uses the same normalized path scope as final source validation",
  { skip: process.platform !== "win32" },
  async (t) => {
    const base = await mkdtemp(join(tmpdir(), "lcode-history-win-path-"));
    const store = createSqliteSessionStore({ dbPath: join(base, "sessions.db") });
    t.after(async () => {
      store.close();
      await rm(base, { recursive: true, force: true });
    });
    const cases = [
      { directory: "E:/Projects/RecordingFreedom" },
      { directory: "E:/elsewhere", path: "e:\\projects\\recordingfreedom\\" },
      { directory: "E:/Projects/RecordingFreedom-other" },
      { directory: "E:/Projects/RecordingFreedom", workspaceID: "remote-other" as never },
      { directory: "E:/Projects/RecordingFreedom", workspaceID: "  " as never },
    ];
    for (const [i, scope] of cases.entries()) {
      await store.createSession({
        id: `win_path_${i}` as SessionId,
        projectID: "fixture" as ProjectId,
        ...scope,
        taskType: "interactive",
        title: "RecordingFreedom test:unit",
        slug: `win_path_${i}`,
        version: "1",
      });
    }
    const found = await store.discoverSessionHistory!({
      workspaceRoot: "E:\\Projects\\RecordingFreedom",
      excludeSessionID: "current" as SessionId,
      queryTerms: ["RecordingFreedom"],
      limit: 8,
    });
    assert.deepEqual(found.candidates.map((c) => c.session.id).sort(), [
      "win_path_0",
      "win_path_1",
      "win_path_4",
    ]);
  },
);

test("history discovery finds older body hits and late message boundaries within workspace", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "lcode-history-discovery-"));
  const store = createSqliteSessionStore({ dbPath: join(base, "sessions.db") });
  t.after(async () => {
    store.close();
    await rm(base, { recursive: true, force: true });
  });
  for (let s = 0; s < 14; s++) {
    const sessionID = `sess_discovery_${s}` as SessionId;
    await store.createSession({
      id: sessionID,
      projectID: "fixture-project" as ProjectId,
      directory: "/fixture-workspace",
      workspaceID: s === 13 ? ("remote-other" as never) : undefined,
      taskType: "interactive",
      title: "Generic task",
      slug: sessionID,
      version: "1",
      time: { created: s + 1, updated: s + 1 },
    });
    const count = s === 0 ? 600 : 1;
    for (let m = 0; m < count; m++) {
      const id = `msg_${s}_${m}` as MessageId;
      await store.saveMessage({
        id,
        sessionID,
        role: "user",
        agent: "build",
        time: { created: m + 1 },
      });
      await store.savePart({
        id: `part_${s}_${m}` as PartId,
        sessionID,
        messageID: id,
        type: "text",
        text:
          (s === 0 && m === 597) || s === 13 ? "reconnect_lease 避免重复执行" : "unrelated colors",
      });
    }
  }
  const found = await store.discoverSessionHistory!({
    workspaceRoot: "/fixture-workspace",
    excludeSessionID: "current" as SessionId,
    queryTerms: ["reconnect_lease"],
    limit: 8,
  });
  assert.equal(found.candidates.length, 8);
  assert.equal(found.candidates[0]?.session.id, "sess_discovery_0");
  assert.equal(found.candidates[0]?.throughMessageID, "msg_0_599");
  assert.ok(found.candidates.every((c) => !c.session.workspaceID));
  assert.equal(found.partial, true);
  const window = await store.readTranscriptWindow({
    sessionID: found.candidates[0]!.session.id,
    throughMessageID: found.candidates[0]!.throughMessageID!,
    limits: { maxMessageRows: 96, maxPartRows: 384, maxDataBytes: 98_304 },
  });
  assert.equal(window.prefixTruncated, true);
  assert.ok(JSON.stringify(window.messages).includes("reconnect_lease"));
});

test("discovery admits at most two MiB of JSON before returning rows from SQLite", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "lcode-history-budget-"));
  const store = createSqliteSessionStore({ dbPath: join(base, "sessions.db") });
  t.after(async () => {
    store.close();
    await rm(base, { recursive: true, force: true });
  });
  for (let s = 0; s < 20; s++) {
    const sessionID = `budget_session_${s}` as SessionId;
    await store.createSession({
      id: sessionID,
      projectID: "fixture" as ProjectId,
      directory: "/fixture",
      taskType: "interactive",
      title: "unrelated",
      slug: sessionID,
      version: "1",
    });
    for (let p = 0; p < 16; p++) {
      const id = `budget_message_${s}_${p}` as MessageId;
      await store.saveMessage({
        id,
        sessionID,
        role: "user",
        agent: "build",
        time: { created: p + 1 },
      });
      await store.savePart({
        id: `budget_part_${s}_${p}` as PartId,
        sessionID,
        messageID: id,
        type: "text",
        text: "payload ".repeat(1500),
      });
    }
  }
  let loaded = 0;
  const original = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    const statement = original.call(this, sql);
    if (!sql.includes("with selected as materialized")) return statement;
    return {
      all(...args: never[]) {
        const rows = statement.all(...args) as { data: string | null; data_bytes: number }[];
        for (const row of rows)
          if (row.data !== null) {
            loaded += row.data_bytes;
            assert.ok(loaded <= HISTORY_DISCOVERY_TOTAL_BYTES);
          }
        return rows;
      },
    };
  });
  const result = await store.discoverSessionHistory!({
    workspaceRoot: "/fixture",
    excludeSessionID: "current" as SessionId,
    queryTerms: ["needle"],
    limit: 8,
  });
  assert.ok(loaded > HISTORY_DISCOVERY_TOTAL_BYTES - 16 * 1024);
  assert.equal(result.partial, true);
});
