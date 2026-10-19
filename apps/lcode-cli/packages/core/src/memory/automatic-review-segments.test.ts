import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { MemoryLearningLease, ProjectMemoryPort } from "@lcode/contracts";
import { runAutomaticMemoryReview } from "./automatic-review.js";
import { reviewHarness, REVIEW_CURRENT_SESSION } from "./review-test-fixtures.js";

test("segmented automatic learning resumes after failure and never pays for consumed segments again", async () => {
  const h = reviewHarness({ allowDerivedSignals: true });
  h.context.reviewMode = "incremental";
  h.context.turnId = "turn_fixture" as import("@lcode/contracts").TurnId;
  h.context.reviewBoundary = {
    sessionId: REVIEW_CURRENT_SESSION,
    startMessageId: "user",
    messageId: "end",
  };
  const session = await h.context.sessionStore!.getSession(h.context.sessionId);
  const consumed = new Set<string>();
  const claims = new Map<string, MemoryLearningLease>();
  h.context.fileSystemPort!.projectMemory = {
    inspectCapacity: async () => ({ available: true }),
    learning: {
      claim: async (input) => {
        if (consumed.has(input.evidenceKey)) return { status: "consumed" };
        const lease = { ...input, token: randomUUID(), expiresAt: Date.now() + 180_000 };
        claims.set(input.evidenceKey, lease);
        return { status: "claimed", lease };
      },
      finish: async ({ lease }) => {
        consumed.add(lease.evidenceKey);
        claims.delete(lease.evidenceKey);
      },
      release: async ({ lease }) => {
        claims.delete(lease.evidenceKey);
      },
    },
  } as ProjectMemoryPort;
  h.context.sessionStore!.readMemoryReviewEvidence = async (input) => {
    const page = input.cursor ? Number(input.cursor.partId) : 0;
    return {
      session,
      status: "ready",
      startMessageID: "user",
      throughMessageID: "end",
      selection: "a".repeat(64),
      content: `User: durable fixture-${page}. Assistant: completed fixture-${page}.`,
      projectedRows: 1,
      ...(page < 2
        ? {
            nextCursor: {
              messageId: "message",
              partId: String(page + 1),
              offset: 0,
              selection: "a".repeat(64),
            },
          }
        : {}),
    };
  };
  let requests = 0;
  let fail = true;
  h.state.reply = () => {
    if (++requests === 2 && fail) throw new Error("fixture failure");
    return { text: JSON.stringify({ summary: "Nothing new", items: [] }) };
  };
  await assert.rejects(
    runAutomaticMemoryReview({ query: "Review fixture facts", context: h.context }),
    { code: "model_failed" },
  );
  assert.equal(consumed.size, 1);
  assert.equal(claims.size, 0);
  fail = false;
  const result = await runAutomaticMemoryReview({
    query: "Review fixture facts",
    context: h.context,
  });
  assert.equal(result.status, "no-change");
  assert.ok(
    h.requests.some((request) =>
      JSON.stringify(request.messages).includes("Adjacent preceding original text"),
    ),
    "later pages retain separately labelled original context",
  );
  assert.equal(consumed.size, 3);
  assert.equal(requests, 4);
  await runAutomaticMemoryReview({ query: "Review fixture facts", context: h.context });
  assert.equal(requests, 4);
});

test("missing evidence after admission cannot become no-change or consume a lease", async () => {
  const h = reviewHarness();
  h.context.reviewMode = "incremental";
  h.context.reviewBoundary = { sessionId: REVIEW_CURRENT_SESSION, messageId: "missing" };
  h.context.fileSystemPort!.projectMemory = {
    inspectCapacity: async () => ({ available: true }),
  } as ProjectMemoryPort;
  await assert.rejects(
    runAutomaticMemoryReview({ query: "Review fixture facts", context: h.context }),
    { code: "source_unavailable" },
  );
  assert.equal(h.requests.length, 0);
});

test("request deadline and explicit cancellation have distinct stable codes without raw reasons", async () => {
  for (const [name, code] of [
    ["TimeoutError", "request_timeout"],
    ["AbortError", "cancelled"],
  ] as const) {
    const h = reviewHarness();
    h.context.abortSignal = AbortSignal.abort(new DOMException("PRIVATE_REASON", name));
    h.context.fileSystemPort!.projectMemory = {
      inspectCapacity: async () => ({ available: true }),
    } as ProjectMemoryPort;
    await assert.rejects(
      runAutomaticMemoryReview({ query: "Review fixture facts", context: h.context }),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, code);
        assert.ok(!String(error).includes("PRIVATE_REASON"));
        return true;
      },
    );
  }
});
