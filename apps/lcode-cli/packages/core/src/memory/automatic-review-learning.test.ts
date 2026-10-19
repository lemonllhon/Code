import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectMemoryPort } from "@lcode/contracts";
import { runAutomaticMemoryReview } from "./automatic-review.js";
import { reviewHarness, reviewMessage, REVIEW_CURRENT_SESSION } from "./review-test-fixtures.js";

test("incremental no-change evidence is consumed before another model request", async () => {
  const h = reviewHarness();
  const message = reviewMessage(
    REVIEW_CURRENT_SESSION,
    "Remember this stable project preference",
    "msg_boundary",
  );
  h.transcripts.set(REVIEW_CURRENT_SESSION, [message]);
  h.context.reviewMode = "incremental";
  h.context.reviewBoundary = { sessionId: REVIEW_CURRENT_SESSION, messageId: message.info.id };
  let consumed = false;
  let finishes = 0;
  let releases = 0;
  h.context.fileSystemPort!.projectMemory = {
    inspectCapacity: async () => ({ available: true }),
    learning: {
      claim: async (input) =>
        consumed
          ? { status: "consumed" }
          : {
              status: "claimed",
              lease: {
                workspaceKey: input.workspaceKey,
                evidenceKey: input.evidenceKey,
                token: "00000000-0000-4000-8000-000000000001",
                expiresAt: Date.now() + 180_000,
              },
            },
      finish: async () => {
        finishes++;
        consumed = true;
      },
      release: async () => {
        releases++;
      },
    },
  } as ProjectMemoryPort;
  h.state.reply = () => ({ text: JSON.stringify({ summary: "Nothing new", items: [] }) });
  await runAutomaticMemoryReview({ query: "Review durable project facts", context: h.context });
  const second = await runAutomaticMemoryReview({
    query: "Review durable project facts",
    context: h.context,
  });
  assert.equal(h.requests.length, 1);
  assert.equal(finishes, 1);
  assert.equal(releases, 0);
  assert.equal(second.skippedReason, "already-consumed");
});

test("failed model generation releases evidence without marking it consumed", async () => {
  const h = reviewHarness();
  const message = reviewMessage(
    REVIEW_CURRENT_SESSION,
    "Remember stable project preference",
    "msg_boundary",
  );
  h.transcripts.set(REVIEW_CURRENT_SESSION, [message]);
  h.context.reviewMode = "incremental";
  h.context.reviewBoundary = { sessionId: REVIEW_CURRENT_SESSION, messageId: message.info.id };
  let releases = 0;
  h.context.fileSystemPort!.projectMemory = {
    inspectCapacity: async () => ({ available: true }),
    learning: {
      claim: async (input) => ({
        status: "claimed",
        lease: {
          workspaceKey: input.workspaceKey,
          evidenceKey: input.evidenceKey,
          token: "00000000-0000-4000-8000-000000000001",
          expiresAt: Date.now() + 180_000,
        },
      }),
      finish: async () => {
        assert.fail("Failed evidence must not be consumed");
      },
      release: async () => {
        releases++;
      },
    },
  } as ProjectMemoryPort;
  h.state.reply = () => {
    throw new Error("fixture provider failure");
  };
  await assert.rejects(
    runAutomaticMemoryReview({ query: "Review durable project facts", context: h.context }),
  );
  assert.equal(releases, 1);
});
