import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { ProjectMemoryRecallIndex } from "./recall/project-memory-recall.js";
import { collectReviewMemoryEvidence } from "./review-memory-evidence.js";
import { reviewHarness, REVIEW_FIXTURE_MEMORY_ROOT } from "./review-test-fixtures.js";

test("review shares body relevance without scanning or reading extra targets", async () => {
  const h = reviewHarness();
  h.files.clear();
  for (const [name, content] of [
    ["aaa.md", "unrelated display colors"],
    ["bbb.md", "unrelated animation frames"],
    ["zzz.md", "reconnect_lease preserves pending mobile input"],
  ])
    h.files.set(join(REVIEW_FIXTURE_MEMORY_ROOT, name!), { content: content! });
  const index = new ProjectMemoryRecallIndex();
  await index.recall({
    fileSystem: h.context.fileSystemPort!,
    rootDir: REVIEW_FIXTURE_MEMORY_ROOT,
    query: "reconnect_lease",
    signal: h.context.abortSignal,
  });
  h.context.selectMemoryCandidates = index.createCandidateSelector(REVIEW_FIXTURE_MEMORY_ROOT);
  h.context.reviewMode = "incremental";
  h.reads.length = 0;
  const evidence = await collectReviewMemoryEvidence("reconnect_lease", h.context);
  assert.equal(evidence.materials[0]?.source.reference, "zzz.md");
  assert.ok(h.reads.length <= 2);
  assert.deepEqual(
    index.createCandidateSelector(join(REVIEW_FIXTURE_MEMORY_ROOT, "foreign"))("reconnect_lease"),
    [],
  );
});

test("candidate selector cannot introduce an unenumerated target", async () => {
  const h = reviewHarness();
  h.context.selectMemoryCandidates = () => ["../../foreign.md", "missing.md"];
  const evidence = await collectReviewMemoryEvidence("preferences", h.context);
  assert.ok(evidence.fileNames.every((name) => !name.includes("..")));
  assert.ok(h.reads.every((name) => !name.endsWith("missing.md")));
});

test("candidate selector remains frozen after the same runtime index reconciles new content", async () => {
  const h = reviewHarness();
  h.files.clear();
  const path = join(REVIEW_FIXTURE_MEMORY_ROOT, "fact.md");
  h.files.set(path, { content: "reconnect_lease validates ownership" });
  const index = new ProjectMemoryRecallIndex();
  const recall = (query: string) =>
    index.recall({
      fileSystem: h.context.fileSystemPort!,
      rootDir: REVIEW_FIXTURE_MEMORY_ROOT,
      query,
      signal: h.context.abortSignal,
    });
  await recall("reconnect_lease");
  const frozen = index.createCandidateSelector(REVIEW_FIXTURE_MEMORY_ROOT);
  h.files.set(path, { content: "glyph_layout handles typography" });
  await recall("glyph_layout");
  assert.deepEqual(frozen("reconnect_lease"), ["fact.md"]);
  assert.deepEqual(
    index.createCandidateSelector(REVIEW_FIXTURE_MEMORY_ROOT)("reconnect_lease"),
    [],
  );
});
