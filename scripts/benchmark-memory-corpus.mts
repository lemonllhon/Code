import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createNodeFileSystemAdapter } from "../apps/lcode-cli/packages/adapters/src/fs/index.js";
import { ProjectMemoryRecallIndex } from "../apps/lcode-cli/packages/core/src/memory/recall/index.js";

const samples = 30,
  warmup = 3;
const base = await mkdtemp(join(tmpdir(), "memory-corpus-benchmark-"));
const rootDir = join(base, "memory");
try {
  await mkdir(rootDir);
  const fileSystem = createNodeFileSystemAdapter();
  await fileSystem.projectMemory!.registerRoot(rootDir);
  for (let i = 0; i < 260; i++)
    await writeFile(join(rootDir, `fact-${i}.md`), `Fixture fact ${i}.`);
  const long = "fixture background ".repeat(280_000) + " RareNeedleTail";
  await writeFile(join(rootDir, "long.md"), long);
  const times: number[] = [];
  const index = new ProjectMemoryRecallIndex();
  let indexedBytes = 0,
    returnedBytes = 0;
  for (let i = -warmup; i < samples; i++) {
    const started = performance.now();
    const outcome = await index.recall({ fileSystem, rootDir, query: "RareNeedleTail" });
    const elapsed = performance.now() - started;
    assert.equal(outcome.candidateCount, 261);
    assert.equal(outcome.health.failedFileCount, 0);
    assert.ok(outcome.results.some((result) => JSON.stringify(result).includes("RareNeedleTail")));
    indexedBytes = outcome.health.indexedBytes;
    returnedBytes = Buffer.byteLength(JSON.stringify(outcome));
    if (i >= 0) times.push(elapsed);
    if (i >= 0 && (i + 1) % 10 === 0) process.stderr.write(`Corpus samples: ${i + 1}/${samples}\n`);
  }
  times.sort((a, b) => a - b);
  const result = {
    node: process.version,
    samples,
    files: 261,
    indexedBytes,
    returnedBytes,
    p50Ms: times[Math.ceil((samples - 1) * 0.5)],
    p95Ms: times[Math.ceil((samples - 1) * 0.95)],
    note: "Real filesystem full corpus traversal, lexical matching beyond the old 4 MiB boundary; no model or network.",
  };
  const artifact = resolve(".artifacts/memory-evidence-performance-20261019");
  await mkdir(artifact, { recursive: true });
  await writeFile(join(artifact, "corpus-results.json"), JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} finally {
  await rm(base, { recursive: true, force: true });
}
