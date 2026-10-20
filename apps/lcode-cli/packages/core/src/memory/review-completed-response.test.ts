import assert from "node:assert/strict";
import test from "node:test";
import { generateMemoryReviewDraft } from "./review-generation.js";
import { verifyMemoryReviewDraft } from "./review-verification.js";
import {
  oneReviewItem,
  reviewDecisionResponse,
  reviewHarness,
  REVIEW_CURRENT_SESSION,
} from "./review-test-fixtures.js";

const QUERY = "Review completed project work";

test("complete generation and verification survive overreported output usage without another request", async () => {
  const h = reviewHarness();
  const warnings: unknown[] = [];
  h.context.observeMemoryReviewDiagnostic = (diagnostic) => warnings.push(diagnostic);
  h.state.reply = (request) => ({
    ...oneReviewItem(request),
    usage: { outputTokens: request.options!.maxOutputTokens! + 100, reasoningTokens: 4000 },
  });
  const draft = await generateMemoryReviewDraft({ query: QUERY, context: h.context });
  h.state.reply = (request) => ({
    ...reviewDecisionResponse(draft),
    usage: { outputTokens: request.options!.maxOutputTokens! + 100 },
  });
  const verified = await verifyMemoryReviewDraft({ draft, context: h.context });
  assert.deepEqual(verified.acceptedItemIds, [draft.items[0]!.id]);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(warnings, [
    { phase: "generation", reason: "output-token-usage", actual: 4196, limit: 4096 },
    { phase: "verification", reason: "output-token-usage", actual: 2148, limit: 2048 },
  ]);
});

test("incremental generation advertises one candidate limit and rejects excess with exact diagnostics", async () => {
  const h = reviewHarness();
  h.context.reviewMode = "incremental";
  h.context.reviewBoundary = { sessionId: REVIEW_CURRENT_SESSION, messageId: "msg_review_current" };
  h.state.reply = (request) => {
    const system = String(request.messages[0]!.content);
    assert.doesNotMatch(system, /at most 10 items/u);
    assert.equal(system.match(/at most 3 items/gu)?.length, 1);
    const item = JSON.parse(oneReviewItem(request).text).items[0];
    return {
      text: JSON.stringify({
        summary: "Four supported facts",
        items: Array.from({ length: 4 }, (_, i) => ({ ...item, fileName: `fact-${i}.md` })),
      }),
    };
  };
  await assert.rejects(generateMemoryReviewDraft({ query: QUERY, context: h.context }), {
    code: "budget_exceeded",
    phase: "generation",
    reason: "item-count",
    budget: { actual: 4, limit: 3 },
  });
  assert.equal(h.requests.length, 1);
});

test("response size and model context failures carry distinct bounded reasons", async () => {
  for (const kind of ["response", "context"] as const) {
    const h = reviewHarness();
    if (kind === "response") h.state.reply = () => ({ text: "x".repeat(80_001) });
    else Object.assign(h.model.properties, { contextWindow: 1024 });
    await assert.rejects(generateMemoryReviewDraft({ query: QUERY, context: h.context }), {
      code: "budget_exceeded",
      phase: "generation",
      reason: kind === "response" ? "response-characters" : "model-context",
    });
    assert.equal(h.requests.length, kind === "response" ? 1 : 0);
  }
});

test("usage accounting never admits truncated, malformed or unsupported content", async () => {
  for (const kind of ["length", "json", "source"] as const) {
    const h = reviewHarness();
    h.state.reply = (request) => ({
      ...oneReviewItem(request, kind === "source" ? { sourceIds: ["unknown"] } : {}),
      ...(kind === "length" ? { finishReason: "length" } : {}),
      ...(kind === "json" ? { text: "not JSON" } : {}),
      usage: { outputTokens: 5000 },
    });
    await assert.rejects(generateMemoryReviewDraft({ query: QUERY, context: h.context }), {
      code: kind === "length" ? "output_truncated" : "invalid_response",
    });
    assert.equal(h.requests.length, 1);
  }
});
