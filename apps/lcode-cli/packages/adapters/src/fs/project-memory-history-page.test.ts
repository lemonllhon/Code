import assert from "node:assert/strict";
import test from "node:test";
import { memoryFixture, reviewDraft } from "./project-memory.test-support.js";

test("history pages traverse beyond 100 proposals without loading large bodies into list results", async (t) => {
  const { rootDir, memory } = await memoryFixture(t);
  const draft = reviewDraft();
  for (let i = 0; i < 101; i++) await memory.saveReview({ rootDir, draft });
  const large = reviewDraft();
  large.items[0]!.content = "large durable fact ".repeat(80_000);
  const last = await memory.saveReview({ rootDir, draft: large });
  const ids = new Set<string>();
  let cursor: string | undefined;
  let firstCursor: string | undefined;
  do {
    const page = await memory.listHistoryPage!({ rootDir, kind: "reviews", cursor, limit: 17 });
    assert.equal(page.kind, "reviews");
    if (page.kind !== "reviews") return;
    for (const proposal of page.proposals) {
      assert.ok(!ids.has(proposal.id));
      ids.add(proposal.id);
    }
    assert.ok(JSON.stringify(page).length < 10_000);
    firstCursor ??= page.nextCursor;
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(ids.size, 102);
  assert.ok(ids.has(last.id));
  await assert.rejects(memory.listHistoryPage!({ rootDir, kind: "changes", cursor: firstCursor }));
});
