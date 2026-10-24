import assert from "node:assert/strict";
import test from "node:test";
import {
  usageModelAliasesSchema,
  usageModelName,
  projectAppUsageAliases,
} from "./usage-model-aliases.js";
import type { AppUsageSnapshot } from "./usage-stats.js";

test("usage aliases validate chains and reject cycles, blank names and unbounded input", () => {
  const aliases = usageModelAliasesSchema.parse({ " raw-a ": " raw-b ", "raw-b": "display" });
  assert.equal(usageModelName("raw-a", aliases), "display");
  assert.equal(usageModelName("untouched", aliases), "untouched");
  for (const bad of [
    { a: "a" },
    { a: "b", b: "a" },
    { " ": "name" },
    { a: " " },
    { a: "x".repeat(301) },
    Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`id${i}`, "name"])),
  ])
    assert.equal(usageModelAliasesSchema.safeParse(bad).success, false);
});
test("API alias projection conserves totals and raw ledger, supports removal and unknown models", () => {
  const row = (modelId: string | null, totalTokens: number) => ({
    modelId,
    totalTokens,
    inputTokens: totalTokens - 1,
    outputTokens: 1,
    requestCount: 1,
    share: totalTokens / 100,
  });
  const original = {
    models: [row("raw-a", 30), row("raw-b", 60), row(null, 10)],
    summary: { totalTokens: 100, favoriteModel: { modelId: "raw-b", totalTokens: 60, share: 0.6 } },
    dailyModelUsage: [
      {
        date: "2026-10-24",
        models: [
          { modelId: "raw-a", totalTokens: 30 },
          { modelId: "raw-b", totalTokens: 60 },
        ],
      },
    ],
  } as AppUsageSnapshot;
  const before = structuredClone(original);
  const result = projectAppUsageAliases(original, { "raw-a": "raw-b", "raw-b": "display" });
  assert.deepEqual(
    result.models.map((row) => [row.modelId, row.totalTokens, row.requestCount]),
    [
      ["display", 90, 2],
      [null, 10, 1],
    ],
  );
  assert.equal(result.summary.totalTokens, 100);
  assert.equal(result.summary.favoriteModel?.modelId, "display");
  assert.deepEqual(result.dailyModelUsage[0]!.models, [{ modelId: "display", totalTokens: 90 }]);
  assert.deepEqual(original, before);
  assert.equal(projectAppUsageAliases(original, {}), original);
});
