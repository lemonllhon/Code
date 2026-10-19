import assert from "node:assert/strict";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { digest, memoryFixture, reviewDraft } from "./project-memory.test-support.js";
import { MemoryStore } from "./project-memory-store.js";

test("cancelling at preimage reservation never publishes a new preimage or prepared journal", async (t) => {
  const { rootDir, stateDir, adapter, memory } = await memoryFixture(t);
  const path = join(rootDir, "cancel-copy.md");
  const original = "fixture original ".repeat(24_000);
  const first = await adapter.writeTextFile({ path, content: original, expectedMissing: true });
  const controller = new AbortController();
  const reserve = MemoryStore.prototype.reserveChange;
  t.mock.method(
    MemoryStore.prototype,
    "reserveChange",
    async function (this: MemoryStore, ...args: Parameters<MemoryStore["reserveChange"]>) {
      assert.equal(args[2]?.signal, controller.signal);
      controller.abort();
      return reserve.apply(this, args);
    },
  );
  await assert.rejects(
    adapter.writeTextFile(
      { path, content: "cancelled", expectedRevision: first.revision },
      { signal: controller.signal },
    ),
    { code: "cancelled" },
  );
  assert.equal(await readFile(path, "utf8"), original);
  assert.deepEqual(await readdir(join(stateDir, "preimages")), []);
  assert.equal((await memory.listChanges(rootDir)).length, 1);
});

test("streamed memory pages preserve UTF-8 and reject concurrent changes or cancellation", async (t) => {
  const { rootDir, memory } = await memoryFixture(t);
  const text = "记忆🌱\r\n".repeat(5000);
  await writeFile(join(rootDir, "stream.md"), text);
  const pages = [];
  for await (const page of memory.iterateContentPages!({
    rootDir,
    fileName: "stream.md",
    maxBytes: 1024,
  })) {
    assert.ok(page.bytesRead <= 1024);
    assert.equal(page.hash, digest(text));
    pages.push(page.content);
  }
  assert.equal(pages.join(""), text);
  await assert.rejects(async () => {
    let changed = false;
    for await (const page of memory.iterateContentPages!({
      rootDir,
      fileName: "stream.md",
      maxBytes: 1024,
    })) {
      assert.ok(page);
      if (!changed) {
        changed = true;
        await writeFile(join(rootDir, "stream.md"), "changed");
      }
    }
  });
  const controller = new AbortController();
  await assert.rejects(async () => {
    for await (const page of memory.iterateContentPages!(
      { rootDir, fileName: "stream.md", maxBytes: 1024 },
      { signal: controller.signal },
    )) {
      assert.ok(page);
      controller.abort();
    }
  });
});

test("large UTF-8 memory is fully pageable and a governed range replacement preserves the unseen tail", async (t) => {
  const { rootDir, memory } = await memoryFixture(t);
  const original = "记忆🌱\r\n".repeat(40_000) + "FINAL_FACT";
  await writeFile(join(rootDir, "long.md"), original);
  let offset: number | undefined = 0;
  let full = "";
  let hash: string | undefined;
  do {
    const page = await memory.readContentPage!({
      rootDir,
      fileName: "long.md",
      offset,
      maxBytes: 8192,
      expectedHash: hash,
    });
    hash ??= page.hash;
    full += page.content;
    offset = page.nextOffset;
  } while (offset !== undefined);
  assert.equal(full, original);
  assert.equal(hash, digest(original));
  const first = await memory.readContentPage!({ rootDir, fileName: "long.md", maxBytes: 8192 });
  const draft = reviewDraft();
  draft.items[0] = {
    ...draft.items[0]!,
    fileName: "long.md",
    expectedHash: hash!,
    content: "replacement\n",
    range: { offset: 0, length: first.bytesRead },
  };
  const review = await memory.saveReview({ rootDir, draft });
  const item = review.draft.items[0]!;
  await memory.applyReview({
    rootDir,
    proposalId: review.id,
    revision: review.revision,
    itemId: item.id,
    expectedItemHash: digest(JSON.stringify(item)),
    expectedSourceHashes: [],
  });
  const expected =
    "replacement\n" + Buffer.from(original).subarray(first.bytesRead).toString("utf8");
  assert.equal(await readFile(join(rootDir, "long.md"), "utf8"), expected);
  const changes = await memory.listChanges(rootDir);
  assert.equal(changes[0]!.afterHash, digest(expected));
  const repeated = await memory.applyReview({
    rootDir,
    proposalId: review.id,
    revision: review.revision,
    itemId: item.id,
    expectedItemHash: digest(JSON.stringify(item)),
    expectedSourceHashes: [],
  });
  assert.equal(repeated.id, changes[0]!.id);
  await assert.rejects(
    memory.readContentPage!({ rootDir, fileName: "long.md", maxBytes: 8192, expectedHash: hash }),
  );
  await memory.undoChange({
    rootDir,
    changeId: changes[0]!.id,
    expectedHash: changes[0]!.afterHash,
    expectedBeforeHash: hash!,
  });
  assert.equal(await readFile(join(rootDir, "long.md"), "utf8"), original);
});

test("review content beyond the former per-proposal and record caps is stored in checked pages", async (t) => {
  const { rootDir, memory } = await memoryFixture(t);
  const draft = reviewDraft();
  draft.items[0]!.content = "long durable fact 🌱\n".repeat(80_000);
  const saved = await memory.saveReview({ rootDir, draft });
  const loaded = await memory.readReview({ rootDir, proposalId: saved.id });
  assert.equal(loaded.draft.items[0]!.content, draft.items[0]!.content);
});
