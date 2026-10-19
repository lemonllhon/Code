import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { NodeFileSystemAdapter } from "./index.js";
import { MEMORY_LEARNING_RECORD_LIMIT } from "@lcode/contracts";
import { digest, hasCode, memoryFixture, reviewDraft } from "./project-memory.test-support.js";

test("learning claims serialize across adapters and survive restart without retaining text", async (t) => {
  const { rootDir, stateDir, memory } = await memoryFixture(t);
  const other = new NodeFileSystemAdapter().projectMemory!;
  await other.registerRoot(rootDir);
  const input = { rootDir, workspaceKey: "workspace-fixture", evidenceKey: digest("turn-one") };
  const results = await Promise.all([memory.learning!.claim(input), other.learning!.claim(input)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["busy", "claimed"]);
  const claimed = results.find((r) => r.status === "claimed")!;
  assert.equal(claimed.status, "claimed");
  if (claimed.status !== "claimed") return;
  await memory.learning!.finish({ rootDir, lease: claimed.lease });
  const restarted = new NodeFileSystemAdapter().projectMemory!;
  await restarted.registerRoot(rootDir);
  assert.equal((await restarted.learning!.claim(input)).status, "consumed");
  assert.equal(
    (await restarted.learning!.claim({ ...input, workspaceKey: "other-workspace" })).status,
    "claimed",
  );
  for (const name of await readdir(join(stateDir, "learning")))
    assert.ok(!(await readFile(join(stateDir, "learning", name), "utf8")).includes("turn-one"));
});

test("expired learning tokens cannot finish, release or commit a replacement claim", async (t) => {
  const { rootDir, stateDir, memory } = await memoryFixture(t);
  const input = { rootDir, workspaceKey: "workspace-fixture", evidenceKey: digest("turn") };
  const initial = await memory.learning!.claim(input);
  assert.equal(initial.status, "claimed");
  if (initial.status !== "claimed") return;
  const key = createHash("sha256")
    .update(JSON.stringify([input.workspaceKey, input.evidenceKey]))
    .digest("hex");
  const path = join(stateDir, "learning", `${key}.json`);
  const ledger = JSON.parse(await readFile(path, "utf8"));
  ledger.records[0].lease.expiresAt = 0;
  await writeFile(path, JSON.stringify(ledger));
  const next = await memory.learning!.claim(input);
  assert.equal(next.status, "claimed");
  if (next.status !== "claimed") return;
  await assert.rejects(
    memory.learning!.finish({ rootDir, lease: initial.lease }),
    hasCode("stale_write"),
  );
  await memory.learning!.release({ rootDir, lease: initial.lease });
  assert.equal((await memory.learning!.claim(input)).status, "busy");
  const proposal = await memory.saveReview({ rootDir, draft: reviewDraft() });
  const item = proposal.draft.items[0]!;
  await assert.rejects(
    memory.applyReview({
      rootDir,
      proposalId: proposal.id,
      revision: proposal.revision,
      itemId: item.id,
      expectedItemHash: digest(JSON.stringify(item)),
      expectedSourceHashes: [],
      learningLease: initial.lease,
    }),
    hasCode("stale_write"),
  );
  await memory.learning!.release({ rootDir, lease: next.lease });
  assert.equal((await memory.learning!.claim(input)).status, "claimed");
});

test("full learning ledgers never evict consumed evidence and aborted claims leave no entry", async (t) => {
  const { rootDir, stateDir, memory } = await memoryFixture(t);
  const input = { rootDir, workspaceKey: "fixture", evidenceKey: digest("new") };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(memory.learning!.claim(input, { signal: controller.signal }));
  const lease = {
    workspaceKey: "fixture",
    evidenceKey: digest("old"),
    token: "00000000-0000-4000-8000-000000000001",
    expiresAt: 0,
  };
  const records = Array.from({ length: MEMORY_LEARNING_RECORD_LIMIT }, (_, index) => ({
    workspaceKey: "fixture",
    evidenceKey: digest(String(index)),
    lease: { ...lease, evidenceKey: digest(String(index)) },
    consumed: true,
  }));
  const path = join(stateDir, "learning.json");
  const bytes = JSON.stringify({ schemaVersion: 1, rootDir, records });
  await writeFile(path, bytes);
  assert.equal((await memory.learning!.claim(input)).status, "claimed");
  assert.equal(await readFile(path, "utf8"), bytes);
  assert.equal(
    (await memory.learning!.claim({ ...input, evidenceKey: records[0]!.evidenceKey })).status,
    "consumed",
  );
});
