import assert from "node:assert/strict";
import test from "node:test";
import { ProjectMemoryReviewSourceSchema } from "@lcode/contracts";
import { createReviewSource, reviewSourceCharacterLimit } from "./review-common.js";
import { reviewHarness, REVIEW_CURRENT_SESSION } from "./review-test-fixtures.js";

test("versioned selector identity survives schema field order normalization and rejects unknown versions", () => {
  const h = reviewHarness();
  const segment = {
    startMessageID: "start",
    cursor: { messageId: "mid", partId: "part", offset: 1, selection: "a".repeat(64) },
    maxCharacters: 1024,
    turnId: "turn_fixture",
  };
  const source = createReviewSource({
    context: h.context,
    kind: "session",
    reference: REVIEW_CURRENT_SESSION,
    characterLimit: 1024,
    boundaryMessageId: "end",
    projection: "completed-turn-v2",
    segment,
    material: "fixture",
  });
  const parsed = ProjectMemoryReviewSourceSchema.parse(source);
  assert.equal(reviewSourceCharacterLimit(parsed, h.context), 1024);
  const reordered = createReviewSource({
    context: h.context,
    kind: "session",
    reference: REVIEW_CURRENT_SESSION,
    characterLimit: 1024,
    boundaryMessageId: "end",
    projection: "completed-turn-v2",
    segment: parsed.segment,
    material: "fixture",
  });
  assert.deepEqual(reordered, source);
  assert.throws(
    () =>
      reviewSourceCharacterLimit(
        { ...source, revision: source.revision.replace("review-v2:", "review-v3:") },
        h.context,
      ),
    { code: "stale_source" },
  );
  const legacy = createReviewSource({
    context: h.context,
    kind: "session",
    reference: REVIEW_CURRENT_SESSION,
    characterLimit: 1024,
    boundaryMessageId: "end",
    projection: "latest-turn",
    material: "fixture",
  });
  assert.match(legacy.revision, /^review-v1:/u);
  assert.equal(
    reviewSourceCharacterLimit(ProjectMemoryReviewSourceSchema.parse(legacy), h.context),
    1024,
  );
});
