import assert from "node:assert/strict";
import test from "node:test";
import type { MessageWithParts, TurnId } from "@lcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { markComposerPredictionBoundary, withComposerPrediction } from "./composer-prediction.js";
import {
  reviewHarness,
  reviewMessage,
  REVIEW_CURRENT_SESSION,
} from "../../memory/review-test-fixtures.js";

function fixture() {
  const h = reviewHarness();
  const done = reviewMessage(
    REVIEW_CURRENT_SESSION,
    "Updated the implementation. A focused regression would be useful.",
    "msg_done",
  );
  done.info = { ...done.info, role: "assistant" } as MessageWithParts["info"];
  h.transcripts.set(REVIEW_CURRENT_SESSION, [
    reviewMessage(REVIEW_CURRENT_SESSION, "Fix reconnect lease ordering", "msg_user"),
    done,
  ]);
  const runtime = {
    config: {},
    sessionId: REVIEW_CURRENT_SESSION,
    sessionStore: h.store,
    workspaceRoot: h.context.workspaceRoot,
    branchGeneration: 1,
    shuttingDown: false,
    latestConversationMessageId: done.info.id,
    latestAssistantMessageId: done.info.id,
    runtimeCommandQueue: { hasPending: () => false },
    pendingInputReservations: new Map(),
    getSessionModelSelection: () => ({ providerId: "fixture", modelId: "model" }),
    getProjection: async () => ({
      pendingPermissions: [],
      pendingSteerInputs: [],
      activeToolCalls: [],
      backgroundTasks: [],
    }),
  } as unknown as AgentRuntimeInternal;
  const input = {
    selection: { providerId: "fixture", modelId: "model" },
    querySource: "composer_prediction",
    composerPrediction: { sessionId: REVIEW_CURRENT_SESSION, boundaryMessageId: done.info.id },
  };
  return { runtime, input, h };
}

test("recovery has no prediction permission; concurrent live requests share one generation", async () => {
  const { runtime, input } = fixture();
  let calls = 0;
  const generate = async (prepared: typeof input) => {
    calls++;
    assert.equal((prepared as unknown as { tools: unknown[] }).tools.length, 0);
    assert.equal(prepared.composerPrediction, undefined);
    return {
      text: '{"suggestion":"补充断线重连的回归验证"}',
      selection: input.selection,
      finishReason: "stop",
    };
  };
  assert.equal(
    (await withComposerPrediction(runtime, input, undefined, generate as never)).text,
    "",
  );
  assert.equal(calls, 0);
  markComposerPredictionBoundary(
    runtime,
    input.composerPrediction.boundaryMessageId,
    "turn_one" as TurnId,
  );
  const result = await Promise.all([
    withComposerPrediction(runtime, input, undefined, generate as never),
    withComposerPrediction(runtime, input, undefined, generate as never),
  ]);
  assert.equal(calls, 1);
  assert.ok(result.every((r) => r.text === "补充断线重连的回归验证"));
});

test("new branch or user input invalidates an in-flight prediction and never retries it", async () => {
  const { runtime, input } = fixture();
  markComposerPredictionBoundary(
    runtime,
    input.composerPrediction.boundaryMessageId,
    "turn_one" as TurnId,
  );
  let calls = 0;
  const generate = async () => {
    calls++;
    runtime.branchGeneration++;
    return { text: '{"suggestion":"stale"}', selection: input.selection, finishReason: "stop" };
  };
  assert.equal((await withComposerPrediction(runtime, input, undefined, generate)).text, "");
  assert.equal((await withComposerPrediction(runtime, input, undefined, generate)).text, "");
  assert.equal(calls, 1);
});

test("provider failures consume the one-request permission; tool calls are never accepted", async () => {
  const { runtime, input } = fixture();
  markComposerPredictionBoundary(
    runtime,
    input.composerPrediction.boundaryMessageId,
    "turn_one" as TurnId,
  );
  let calls = 0;
  const generate = async () => {
    calls++;
    throw new Error("Fixture provider failure");
  };
  await assert.rejects(withComposerPrediction(runtime, input, undefined, generate));
  await assert.rejects(withComposerPrediction(runtime, input, undefined, generate));
  assert.equal(calls, 1);
  const fresh = fixture();
  markComposerPredictionBoundary(
    fresh.runtime,
    fresh.input.composerPrediction.boundaryMessageId,
    "turn_one" as TurnId,
  );
  const result = await withComposerPrediction(fresh.runtime, fresh.input, undefined, async () => ({
    text: '{"suggestion":"unauthorized tool call"}',
    selection: input.selection,
    finishReason: "tool_calls",
    toolCalls: [{}] as never,
  }));
  assert.equal(result.text, "");
  assert.equal(result.toolCalls, undefined);
  const truncated = fixture();
  markComposerPredictionBoundary(
    truncated.runtime,
    truncated.input.composerPrediction.boundaryMessageId,
    "turn_one" as TurnId,
  );
  const lengthResult = await withComposerPrediction(
    truncated.runtime,
    truncated.input,
    undefined,
    async () => ({
      text: '{"suggestion":"syntactically complete but truncated output"}',
      selection: input.selection,
      finishReason: "length",
    }),
  );
  assert.equal(lengthResult.text, "");
});

test("a synthetic latest user cannot reopen an older real-user turn for prediction", async () => {
  const { runtime, input, h } = fixture();
  const messages = h.transcripts.get(REVIEW_CURRENT_SESSION)!;
  messages[0]!.info = { ...messages[0]!.info, synthetic: true } as MessageWithParts["info"];
  messages.unshift(reviewMessage(REVIEW_CURRENT_SESSION, "OLDER_REAL_USER_CONTEXT", "old_real"));
  markComposerPredictionBoundary(
    runtime,
    input.composerPrediction.boundaryMessageId,
    "turn_one" as TurnId,
  );
  const result = await withComposerPrediction(runtime, input, undefined, async () =>
    assert.fail("Synthetic turns must not request a prediction"),
  );
  assert.equal(result.text, "");
});

test("cached predictions revalidate source text without issuing a second model call", async () => {
  const { runtime, input, h } = fixture();
  markComposerPredictionBoundary(
    runtime,
    input.composerPrediction.boundaryMessageId,
    "turn_one" as TurnId,
  );
  let calls = 0;
  const generate = async () => {
    calls++;
    return {
      text: '{"suggestion":"next input"}',
      selection: input.selection,
      finishReason: "stop",
    };
  };
  assert.equal(
    (await withComposerPrediction(runtime, input, undefined, generate)).text,
    "next input",
  );
  const part = h.transcripts.get(REVIEW_CURRENT_SESSION)!.at(-1)!.parts[0]!;
  if (part.type === "text") part.text = "Changed result";
  assert.equal((await withComposerPrediction(runtime, input, undefined, generate)).text, "");
  assert.equal(calls, 1);
});
