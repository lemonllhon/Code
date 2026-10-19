import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type {
  MessageId,
  PartId,
  ProjectId,
  SessionId,
  MemoryEvidenceCursor,
} from "@lcode/contracts";
import { createSqliteSessionStore } from "../session-store.js";

test("memory projection covers long same-turn text while excluding huge tool and reasoning payloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-pages-"));
  const store = createSqliteSessionStore({ dbPath: join(dir, "test.db") });
  const sessionID = "sess_pages" as SessionId;
  try {
    await store.createSession({
      id: sessionID,
      projectID: "project" as ProjectId,
      slug: "pages",
      directory: dir,
      title: "fixture",
      version: "1",
    });
    for (let i = 0; i < 302; i++) {
      const id = `m_${i}` as MessageId;
      const base = { id, sessionID, agent: "build", time: { created: i, completed: i + 1 } };
      await store.saveMessage(
        i === 0
          ? { ...base, role: "user" }
          : {
              ...base,
              role: "assistant",
              parentID: "m_0" as MessageId,
              mode: "build",
              path: { cwd: dir, root: dir },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
      );
      await store.savePart({
        id: `p_${i}` as PartId,
        messageID: id,
        sessionID,
        type: "text",
        text: i === 0 ? "请记住".repeat(4000) : `fact-${i}`,
      });
    }
    await store.saveParts({
      sessionID,
      messageID: "m_1" as MessageId,
      parts: Array.from({ length: 2256 }, (_, i) => ({
        id: `reason_${i}` as PartId,
        messageID: "m_1" as MessageId,
        sessionID,
        type: "reasoning" as const,
        text: "x".repeat(1000),
        time: { start: 1 },
      })),
    });
    await store.savePart({
      id: "huge" as PartId,
      messageID: "m_1" as MessageId,
      sessionID,
      type: "tool",
      tool: "Read",
      callID: "read",
      state: {
        status: "completed",
        input: {},
        output: "PRIVATE".repeat(50000),
        metadata: {},
        title: "read",
        time: { start: 1, end: 2 },
      },
    });
    let cursor: MemoryEvidenceCursor | undefined;
    let content = "";
    let pages = 0;
    do {
      const page = await store.readMemoryReviewEvidence({
        sessionID,
        startMessageID: "m_0",
        throughMessageID: "m_301",
        cursor,
        maxCharacters: 1024,
      });
      assert.equal(page.status, "ready");
      assert.ok(page.content.length <= 1024);
      content += page.content;
      cursor = page.nextCursor;
      assert.ok(++pages < 100);
    } while (cursor);
    assert.ok(pages > 10);
    assert.equal(content.split("请记住").length - 1, 4000);
    assert.ok(content.includes("fact-301"));
    assert.ok(!content.includes("PRIVATE"));
    assert.ok(!content.includes("xxxx"));
    const first = await store.readMemoryReviewEvidence({
      sessionID,
      startMessageID: "m_0",
      throughMessageID: "m_301",
      maxCharacters: 1024,
    });
    const review = {
      id: "review-control" as PartId,
      messageID: "m_301" as MessageId,
      sessionID,
      type: "tool" as const,
      tool: "MemoryReview",
      callID: "review",
      state: {
        status: "completed" as const,
        input: { action: "create" },
        output: "",
        metadata: {},
        title: "review",
        time: { start: 1, end: 2 },
      },
    };
    await store.savePart(review);
    const blocked = await store.readMemoryReviewEvidence({
      sessionID,
      startMessageID: "m_0",
      throughMessageID: "m_301",
      cursor: first.nextCursor,
      maxCharacters: 1024,
    });
    assert.equal(blocked.reason, "foreground-review", "local writes invalidate the control proof");
    await store.removePart({ sessionID, messageID: review.messageID, partID: review.id });
    assert.equal(
      (
        await store.readMemoryReviewEvidence({
          sessionID,
          startMessageID: "m_0",
          throughMessageID: "m_301",
          maxCharacters: 1024,
        })
      ).status,
      "ready",
    );
    const external = new DatabaseSync(store.getDatabasePath());
    try {
      external
        .prepare(
          "insert into part (id,message_id,session_id,sequence,time_created,time_updated,data) values (?,?,?,999,1,1,?)",
        )
        .run(
          "external-review",
          "m_301",
          sessionID,
          JSON.stringify({
            type: "tool",
            tool: "MemoryReview",
            state: { input: { action: "create" } },
          }).replace("MemoryReview", "Memory\\u0052eview"),
        );
      assert.equal(
        (
          await store.readMemoryReviewEvidence({
            sessionID,
            startMessageID: "m_0",
            throughMessageID: "m_301",
            maxCharacters: 1024,
          })
        ).reason,
        "foreground-review",
        "foreign writes and escaped legacy keys cannot bypass review isolation",
      );
      external.prepare("delete from part where id = ?").run("external-review");
    } finally {
      external.close();
    }
    await store.setRevert({ sessionID, revert: { messageID: "m_0" as MessageId } });
    const stale = await store.readMemoryReviewEvidence({
      sessionID,
      startMessageID: "m_0",
      throughMessageID: "m_301",
      cursor: first.nextCursor,
      maxCharacters: 1024,
    });
    assert.equal(stale.status, "unavailable");
  } finally {
    store.close();
    await rm(dir, { force: true, recursive: true });
  }
});
