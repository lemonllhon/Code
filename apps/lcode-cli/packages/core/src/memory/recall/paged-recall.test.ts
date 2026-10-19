import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import test from "node:test";
import type { FileSystemPort } from "@lcode/contracts";
import { ProjectMemoryRecallIndex } from "./project-memory-recall.js";

test("paged recall covers more than 200 files and a fact beyond 4 MiB without retaining the corpus", async () => {
  const rootDir = resolve("recall-page-fixture");
  const contents = new Map(
    Array.from({ length: 260 }, (_, i) => [
      `fixture-${String(i).padStart(3, "0")}.md`,
      "ordinary fixture fact",
    ]),
  );
  contents.set(
    "long.md",
    "background ".repeat(500_000) + "\nRareNeedle durable fact at the very end.",
  );
  let largest = 0;
  let active = 0,
    peak = 0;
  const fs = {
    listDirectory: async (input: { limit: number; page?: { afterName?: string } }) => {
      const names = [...contents.keys()]
        .filter((name) => !input.page?.afterName || name > input.page.afterName)
        .sort();
      const selected = names.slice(0, input.limit);
      return {
        path: rootDir,
        entries: selected.map((name) => ({ name, path: join(rootDir, name), kind: "file" })),
        numEntries: selected.length,
        truncated: names.length > selected.length,
        ...(names.length > selected.length
          ? { nextPage: { afterName: selected.at(-1), revision: "fixture" } }
          : {}),
      };
    },
    projectMemory: {
      readContentPage: async (input: { fileName: string; offset?: number; maxBytes: number }) => {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        const text = contents.get(input.fileName)!;
        const offset = input.offset ?? 0;
        const content = text.slice(offset, offset + input.maxBytes);
        largest = Math.max(largest, content.length);
        return {
          content,
          offset,
          bytesRead: content.length,
          sizeBytes: text.length,
          hash: `sha256:${"a".repeat(64)}`,
          ...(offset + content.length < text.length ? { nextOffset: offset + content.length } : {}),
        };
      },
    },
  } as unknown as FileSystemPort;
  const index = new ProjectMemoryRecallIndex();
  const result = await index.recall({ fileSystem: fs, rootDir, query: "RareNeedle" });
  assert.equal(result.candidateCount, 261);
  assert.equal(result.health?.scanLimited, false);
  assert.ok(result.health!.indexedBytes > 4 * 1024 * 1024);
  assert.ok(result.attachment?.includes("RareNeedle durable fact"));
  assert.ok(largest <= 64 * 1024);
  assert.ok(index.size <= 8);
  assert.ok(peak > 1 && peak <= 8, "filesystem traversal reuses a bounded parallel pool");
  assert.ok(
    index.createCandidateOffsetSelector(rootDir)("RareNeedle")["long.md"]! > 4 * 1024 * 1024,
  );
  contents.set(
    "metadata.md",
    "---\r\ndescription: Fixture\r\n---\r\n" + "context\r\n".repeat(400) + "SpecialNeedle fact",
  );
  await index.recall({ fileSystem: fs, rootDir, query: "SpecialNeedle" });
  assert.equal(
    index.createCandidateOffsetSelector(rootDir)("SpecialNeedle")["metadata.md"],
    contents.get("metadata.md")!.indexOf("SpecialNeedle") - 128,
  );
  const readPage = fs.projectMemory!.readContentPage!;
  fs.projectMemory!.readContentPage = async (input, options) => {
    if (input.fileName === "long.md" && input.offset) throw new Error("Fixture stream interrupted");
    return readPage(input, options);
  };
  const interrupted = await index.recall({ fileSystem: fs, rootDir, query: "RareNeedle" });
  assert.equal(interrupted.health.failedFileCount, 1);
  assert.ok(
    interrupted.health.indexedBytes < 64 * 1024,
    "failed streams publish no partial corpus statistics",
  );
  assert.ok(!interrupted.results.some((entry) => JSON.stringify(entry).includes("RareNeedle")));
  contents.set(
    "expired.md",
    '---\nmetadata:\n  lcode:\n    validUntil: "2000-01-01"\n---\nExpiredNeedle',
  );
  const expired = await index.recall({ fileSystem: fs, rootDir, query: "ExpiredNeedle" });
  assert.equal(expired.health.expiredCount, 1);
  assert.equal(expired.health.indexedBytes, interrupted.health.indexedBytes);
  assert.ok(expired.results.every((entry) => entry.filename !== "expired.md"));
});
