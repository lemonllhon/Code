import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageId, MessagePart, PartId, SessionId } from "@lcode/contracts";
import { createSqliteSessionStore } from "../session-store.js";
import { saveParts } from "./repositories/message-parts.js";

const sessionID = "batch-session" as SessionId;
const messageID = "batch-message" as MessageId;
function part(index: number): Extract<MessagePart, { type: "reasoning" }> {
  return {
    id: `part-${index}` as PartId,
    sessionID,
    messageID,
    type: "reasoning",
    text: `word ${index}\n🦊`,
    metadata: { signature: `signed-${index}` },
    time: { start: 10, end: 20 },
  };
}
async function fixture() {
  const store = createSqliteSessionStore({ dbPath: ":memory:" });
  await store.createSession({
    id: sessionID,
    projectID: "fixture" as never,
    slug: "fixture",
    version: "fixture",
    directory: "/fixture",
    title: "fixture",
  });
  await store.saveMessage({
    id: messageID,
    sessionID,
    role: "user",
    agent: "fixture",
    time: { created: 1 },
  });
  return store;
}

test("batch preserves content, signature, order and idempotent updates", async () => {
  const store = await fixture();
  try {
    const parts = Array.from({ length: 2256 }, (_, i) => part(i));
    await store.saveParts({ sessionID, messageID, parts });
    await store.saveParts({ sessionID, messageID, parts });
    assert.deepEqual((await store.messageWithParts({ sessionID, messageID }))?.parts, parts);
    await store.saveParts({
      sessionID,
      messageID,
      parts: [{ ...part(1), text: "changed" }, part(2256)],
    });
    const saved = (await store.messageWithParts({ sessionID, messageID }))!.parts;
    assert.equal(saved.length, 2257);
    assert.equal(saved[1]?.id, part(1).id);
    assert.equal(saved[1]?.type === "reasoning" && saved[1].text, "changed");
    assert.equal(saved.at(-1)?.id, part(2256).id);
  } finally {
    store.close();
  }
});

test("invalid owners and duplicate ids never partially write", async () => {
  const store = await fixture();
  try {
    await assert.rejects(
      store.saveParts({
        sessionID,
        messageID,
        parts: [part(0), { ...part(1), sessionID: "foreign" as SessionId }],
      }),
      /owner/i,
    );
    await assert.rejects(
      store.saveParts({ sessionID, messageID, parts: [part(0), part(0)] }),
      /duplicate/i,
    );
    await assert.rejects(
      store.saveParts({
        sessionID,
        messageID: "missing" as MessageId,
        parts: [{ ...part(0), messageID: "missing" as MessageId }],
      }),
      /owner/i,
    );
    assert.equal(store.debugCounts().parts, 0);
    await store.saveParts({ sessionID, messageID, parts: [] });
  } finally {
    store.close();
  }
});

test("real SQL failure rolls back all parts and leaves the connection reusable", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`create table session(id text primary key,time_updated integer);
    create table message(id text primary key,session_id text);
    create table part(id text primary key,message_id text,session_id text,time_created integer,time_updated integer,data text,sequence integer);
    insert into session values('batch-session',1); insert into message values('batch-message','batch-session');
    create trigger fail_part before insert on part when new.id='part-1' begin select raise(abort,'injected'); end;`);
  try {
    assert.throws(
      () => saveParts(db, { sessionID, messageID, parts: [part(0), part(1)] }),
      /injected/,
    );
    assert.equal(db.prepare("select count(*) n from part").get()!.n, 0);
    assert.equal(db.prepare("select time_updated from session").get()!.time_updated, 1);
    db.exec("drop trigger fail_part");
    saveParts(db, { sessionID, messageID, parts: [part(0)] });
    db.exec("update part set sequence=null,time_created=7 where id='part-0'");
    saveParts(db, { sessionID, messageID, parts: [part(0), part(1)] });
    const row = db.prepare("select sequence,time_created from part where id='part-0'").get()!;
    assert.equal(row.sequence, null);
    assert.equal(row.time_created, 7);
    assert.throws(
      () =>
        saveParts(db, {
          sessionID,
          messageID: "foreign" as MessageId,
          parts: [{ ...part(0), messageID: "foreign" as MessageId }],
        }),
      /owner/i,
    );
  } finally {
    db.close();
  }
});

test("batch has one sequence scan, one touch, one commit and no half-batch visibility", async () => {
  const root = await mkdtemp(join(tmpdir(), "lcode-parts-test-"));
  const path = join(root, "parts.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`pragma journal_mode=WAL;
    create table session(id text primary key,time_updated integer);
    create table message(id text primary key,session_id text);
    create table part(id text primary key,message_id text,session_id text,time_created integer,time_updated integer,data text,sequence integer);
    insert into session values('batch-session',1); insert into message values('batch-message','batch-session');`);
  const reader = new DatabaseSync(path);
  const visible: number[] = [];
  db.function("observe_batch", () => {
    visible.push(Number(reader.prepare("select count(*) n from part").get()!.n));
    return 0;
  });
  db.exec("create trigger observe before insert on part begin select observe_batch(); end");
  const counts = { scans: 0, touches: 0, commits: 0 };
  const prepare = db.prepare.bind(db),
    exec = db.exec.bind(db);
  db.prepare = (sql) => {
    if (/max\(sequence\)/i.test(sql)) counts.scans++;
    if (/update session set time_updated/i.test(sql)) counts.touches++;
    return prepare(sql);
  };
  db.exec = (sql) => {
    if (sql === "commit") counts.commits++;
    exec(sql);
  };
  try {
    saveParts(db, { sessionID, messageID, parts: [part(0), part(1)] });
    assert.deepEqual(counts, { scans: 1, touches: 1, commits: 1 });
    assert.deepEqual(visible, [0, 0]);
    assert.equal(reader.prepare("select count(*) n from part").get()!.n, 2);
    exec(
      "insert into message values('foreign','batch-session'); update part set message_id='foreign' where id='part-0'",
    );
    assert.throws(
      () => saveParts(db, { sessionID, messageID, parts: [part(2), part(0)] }),
      /owner/i,
    );
    assert.equal(reader.prepare("select count(*) n from part").get()!.n, 2);
    assert.equal(
      reader.prepare("select message_id from part where id='part-0'").get()!.message_id,
      "foreign",
    );
  } finally {
    reader.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
