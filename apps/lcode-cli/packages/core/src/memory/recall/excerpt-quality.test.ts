import assert from "node:assert/strict";
import test from "node:test";
import { selectMemoryExcerpt } from "./excerpt.js";
import { formatMemoryRecallAttachment } from "./project-memory-recall.js";
import type { RankedMemoryDocument } from "./types.js";

function ranked(
  content: string,
  patch: Partial<RankedMemoryDocument["document"]> = {},
): RankedMemoryDocument {
  return {
    score: 1,
    matchedTerms: ["release"],
    document: {
      content,
      filename: "reference.md",
      filePath: "/memory/reference.md",
      type: "reference",
      sourceHash: "fixture-revision",
      indexedBytes: content.length,
      mtimeMs: 1,
      tokenCount: 1,
      metadataTokens: new Set(),
      termFrequencies: new Map(),
      ...patch,
    },
  };
}

test("separated evidence keeps adjacent exceptions and headings without filling the budget with noise", () => {
  const text = [
    "Global restriction: use fixture data only.",
    ...Array(12).fill("Unrelated background."),
    "## Mobile workflow",
    "Never apply outside mobile.",
    "release mobile preserves the lease.",
    "Except on explicit cancellation.",
    ...Array(14).fill("Unrelated background."),
    "## Desktop workflow",
    "release desktop preserves ownership.",
    "Never reuse another session.",
    ...Array(14).fill("Unrelated background."),
  ].join("\n\n");
  const result = selectMemoryExcerpt(text, ["release"], 650);
  for (const fact of [
    "Global restriction",
    "Mobile workflow",
    "Never apply",
    "Except on explicit",
    "Desktop workflow",
    "Never reuse",
    "release mobile",
    "release desktop",
  ])
    assert.ok(result.includes(fact), fact);
  assert.ok(result.length <= 650);
  assert.ok(result.length < text.length / 2);
  assert.match(result, /…/);
});

test("reference has a soft budget while preferences and conflicting sources remain distinct", () => {
  const long = `${"Unrelated introduction.\n\n".repeat(100)}Never publish automatically.\n\nrelease uses the approved workflow.\n\nKeep full errors.`;
  const reference = formatMemoryRecallAttachment([ranked(long)]);
  assert.ok(reference.results[0]!.content.length <= 1200);
  assert.match(reference.results[0]!.content, /Never publish automatically/);
  assert.match(reference.attachment!, /silently/);
  const preference = formatMemoryRecallAttachment([ranked(long, { type: "user" })]);
  assert.equal(preference.results[0]!.content, long);
  const different = formatMemoryRecallAttachment([
    ranked("release requires approval."),
    ranked("release requires approval."),
    ranked("release requires approval.", { filename: "other.md", filePath: "/memory/other.md" }),
    ranked("release is forbidden.", { description: "Conflicting convention" }),
    ranked("release needs a check."),
    ranked("release fifth distinct result."),
  ]);
  assert.equal(different.results.length, 4);
  assert.ok(different.results.some((result) => result.filename === "other.md"));
  assert.ok(different.results.some((result) => result.content.includes("forbidden")));
  assert.ok(different.results.some((result) => result.content.includes("needs a check")));
});

test("deduplication never merges different revisions, metadata or sections", () => {
  const result = formatMemoryRecallAttachment([
    ranked("release needs approval."),
    ranked("release needs approval.", { sourceHash: "second-revision" }),
    ranked("release needs approval.", { description: "Only applies to mobile" }),
    ranked("release is disabled for desktop."),
  ]);
  assert.equal(result.results.length, 4);
  assert.match(result.attachment!, /Only applies to mobile/);
  assert.match(result.attachment!, /disabled for desktop/);
});

test("an oversized best paragraph does not get replaced by an easier secondary hit", () => {
  const result = selectMemoryExcerpt(
    `PRIMARY alpha beta ${"x".repeat(1500)}\n\nNoise.\n\nsecondary alpha.`,
    ["alpha", "beta"],
    100,
  );
  assert.match(result, /PRIMARY alpha beta/);
  assert.doesNotMatch(result, /secondary/);
});
