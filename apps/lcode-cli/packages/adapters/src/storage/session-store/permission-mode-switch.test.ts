import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { SessionStorePort, SessionId } from "@lcode/contracts";
import { commitPermissionFullAccess } from "./repositories/permission-full-access.js";

type Commit = Parameters<NonNullable<SessionStorePort["commitPermissionFullAccess"]>>[0];
const sessionID = "fixture" as SessionId;
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`create table session_entry(id text primary key,session_id text,type text,time_created integer,time_updated integer,data text);
    create table session_input(id text primary key,session_id text,status text,time_updated integer,payload text);`);
  const original = {
    text: "fixture",
    intent: { mode: "build", planEnabled: true, modelSelection: { modelId: "frozen" } },
    conversationInputIntent: { mode: "build", planEnabled: false },
    other: { keep: true },
  };
  for (const id of ["queued", "later"])
    db.prepare("insert into session_input values (?, 'fixture', 'admitted', 1, ?)").run(
      id,
      JSON.stringify(original),
    );
  const input = (mode: "build" | "edit" | "yolo", id = mode): Commit => ({
    sessionID,
    queueItemIds: ["queued"],
    mode,
    execution: {
      id: "execution",
      sessionID,
      type: "runtime/execution_state",
      touchSession: false,
      time: { created: 1, updated: 2 },
      data: { mode, planEnabled: true },
    },
    receipt: {
      id,
      sessionID,
      type: "runtime/permission_full_access",
      touchSession: false,
      time: { created: 1, updated: 2 },
      data: { interactionId: id, mode },
    },
  });
  const payload = (id = "queued") =>
    JSON.parse(String(db.prepare("select payload from session_input where id=?").get(id)!.payload));
  return { db, original, input, payload };
}

test("SQLite commits all permission modes, both intent forms and execution/receipt together", async () => {
  const f = fixture();
  try {
    for (const mode of ["yolo", "edit", "build"] as const) {
      await commitPermissionFullAccess(f.db, f.input(mode));
      assert.deepEqual(f.payload(), {
        ...f.original,
        intent: { ...f.original.intent, mode },
        conversationInputIntent: { ...f.original.conversationInputIntent, mode },
      });
      assert.deepEqual(f.payload("later"), f.original);
      assert.equal(
        JSON.parse(
          String(f.db.prepare("select data from session_entry where id='execution'").get()!.data),
        ).mode,
        mode,
      );
    }
    const retry = { ...f.input("yolo"), queueItemIds: ["queued", "later"] };
    await commitPermissionFullAccess(f.db, retry);
    assert.equal(
      f.payload().intent.mode,
      "build",
      "old receipt cannot replay its state or expand its fixed target set",
    );
    assert.deepEqual(f.payload("later"), f.original);
  } finally {
    f.db.close();
  }
});

test("a receipt write failure rolls back queued modes and execution state", async () => {
  const f = fixture();
  try {
    f.db.exec(
      "create trigger fail_receipt before insert on session_entry when NEW.id='yolo' begin select raise(abort,'receipt failed'); end",
    );
    await assert.rejects(commitPermissionFullAccess(f.db, f.input("yolo")), /receipt failed/);
    assert.deepEqual(f.payload(), f.original);
    assert.equal(f.db.prepare("select count(*) as n from session_entry").get()!.n, 0);
    f.db.exec("drop trigger fail_receipt");
    await commitPermissionFullAccess(f.db, f.input("yolo"));
    assert.equal(f.payload().intent.mode, "yolo");
  } finally {
    f.db.close();
  }
});

test("missing or foreign queue ownership and cancellation leave the transaction unchanged", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      commitPermissionFullAccess(f.db, { ...f.input("yolo"), queueItemIds: ["queued", "missing"] }),
      /unavailable/,
    );
    const signal = AbortSignal.abort();
    await assert.rejects(commitPermissionFullAccess(f.db, { ...f.input("yolo"), signal }));
    await assert.rejects(
      commitPermissionFullAccess(f.db, { ...f.input("yolo"), sessionID: "foreign" as never }),
      /mismatch/,
    );
    assert.deepEqual(f.payload(), f.original);
    assert.equal(f.db.prepare("select count(*) as n from session_entry").get()!.n, 0);
  } finally {
    f.db.close();
  }
});
