import assert from "node:assert/strict";
import test from "node:test";
import type { MessageId, SessionStorePort } from "@lcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { persistAssistantContent } from "./assistant-content-persistence.js";
import { persistCancelledStreamSnapshot } from "./cancelled-stream-persistence.js";
import { commitModelStepResult } from "./turn-model-step-result.js";

const input = {
  assistantMessageId: "fixture" as MessageId,
  createdAt: 1,
  traceContext: {},
  reasoning: [
    { type: "reasoning" as const, text: " first\n", providerOptions: { signature: "signed-a" } },
    { type: "reasoning" as const, text: "第二段 🦊", providerOptions: { signature: "signed-b" } },
  ],
  text: "final",
};

test("success and cancellation use one atomic content port and preserve real block metadata", async () => {
  const calls: Parameters<SessionStorePort["saveParts"]>[0][] = [];
  const runtime = {
    sessionId: "session",
    sessionStore: {
      saveParts: async (batch: (typeof calls)[number]) => {
        calls.push(batch);
      },
    },
    persistPart: () => {
      throw Error("must not use per-part commits");
    },
  } as unknown as AgentRuntimeInternal;
  await persistAssistantContent(runtime, input);
  await persistCancelledStreamSnapshot(runtime, {
    assistantCreatedAt: input.createdAt,
    assistantMessageId: input.assistantMessageId,
    traceContext: {},
    snapshot: input,
  });
  assert.equal(calls.length, 2);
  for (const batch of calls) {
    assert.equal(batch.parts.length, 3);
    assert.deepEqual(
      batch.parts.map((p) => p.type),
      ["reasoning", "reasoning", "text"],
    );
    assert.deepEqual(
      batch.parts.filter((p) => p.type === "reasoning").map((p) => p.metadata),
      input.reasoning.map((r) => r.providerOptions),
    );
    assert.equal(
      batch.parts[1]?.type === "reasoning" && batch.parts[1].text,
      input.reasoning[1]!.text,
    );
    assert.equal(new Set(batch.parts.map((p) => p.id)).size, 3);
  }
});

test("commit failure propagates without a per-part fallback or success event", async () => {
  let successes = 0;
  const failure = Error("storage failed");
  const runtime = {
    sessionId: "session",
    sessionStore: {
      saveParts: async () => {
        throw failure;
      },
    },
    logger: {
      info: () => {
        successes++;
      },
    },
  } as unknown as AgentRuntimeInternal;
  await assert.rejects(persistAssistantContent(runtime, input), (error) => error === failure);
  assert.equal(successes, 0);
});

test("failed content commit never reaches model-complete or post-stream tools", async () => {
  const failure = Error("storage failed");
  let completed = 0;
  const runtime = {
    sessionId: "session",
    sessionStore: {
      saveParts: async () => {
        throw failure;
      },
    },
    extractToolCallsFromResult: () => [{ id: "write", name: "Write", input: {} }],
    appendEvent: () => {
      completed++;
    },
    executeTools: () => {
      throw Error("must not execute tools before commit");
    },
  } as unknown as AgentRuntimeInternal;
  const state = {
    modelResponse: "",
    modelStepCount: 0,
    tokenCount: 0,
    turnRequestState: { outputTokenContinuationCount: 0 },
  };
  const execution = {
    assistantMessageId: input.assistantMessageId,
    modelStartedAt: 1,
    modelTraceContext: {},
    querySource: "main_turn",
    model: { providerId: "fixture", modelId: "fixture" },
  };
  const result = {
    text: input.text,
    reasoning: input.reasoning,
    usage: {},
    finishReason: "tool-calls",
  };
  await assert.rejects(
    commitModelStepResult.call(
      runtime,
      state as never,
      {} as never,
      execution as never,
      result as never,
    ),
    (error) => error === failure,
  );
  assert.equal(completed, 0);
});
