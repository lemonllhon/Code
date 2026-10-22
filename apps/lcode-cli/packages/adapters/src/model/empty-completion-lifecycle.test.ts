import assert from "node:assert/strict";
import test from "node:test";
import {
  createModelId,
  createModelProviderId,
  ModelRetryBudget,
  type ModelStreamEvent,
} from "@lcode/contracts";
import { runGenerateText } from "./runner-generate.js";
import { runStreamText } from "./runner-stream.js";
import type { AiSdkModelRuntime, ResolvedAiSdkModel } from "./runner-runtime.js";
import { isZeroOutputModelCompletion } from "./runner-diagnostics.js";

const resolved = {
  model: {},
  modelId: createModelId("fixture"),
  providerId: createModelProviderId("fixture"),
  providerKind: "openai-compatible",
  properties: {
    contextWindow: 128000,
    inputFormat: { text: true, image: false },
    outputFormat: { text: true },
    requiresMfjsToolSchema: false,
    supportsJsonSchemaOutput: false,
    supportsMidConversationSystem: true,
    supportsNativeWebSearch: false,
    supportsToolCall: true,
  },
} as unknown as ResolvedAiSdkModel;
const retry = { maxAttempts: 10, baseDelayMs: 0, maxDelayMs: 0, backoffFactor: 1, jitter: false };

for (const mode of ["generate", "stream"] as const)
  for (const unbounded of [false, true]) {
    test(`${mode}: repeated empty length completion terminates after two calls without success (workflow=${unbounded})`, async () => {
      let calls = 0,
        successes = 0;
      const statuses: string[] = [],
        events: ModelStreamEvent[] = [];
      const model = {
        ...resolved,
        observeRoutingUsage: async () => {
          successes++;
        },
      };
      const runtime = {
        async generateText() {
          calls++;
          if (calls > 2) throw new Error("retry escaped empty budget");
          return { text: "", finishReason: "length", totalUsage: {} };
        },
        streamText() {
          calls++;
          if (calls > 2) throw new Error("retry escaped empty budget");
          return {
            fullStream: (async function* () {
              yield { type: "start", warnings: [] };
              yield { type: "finish", finishReason: "length", totalUsage: {} };
            })(),
          };
        },
      } as unknown as AiSdkModelRuntime;
      const input = {
        env: {},
        modelIoFullRetentionEnabled: false,
        request: {
          messages: [{ role: "user" as const, content: "fixture" }],
          ...(unbounded ? { modelRetryBudget: ModelRetryBudget.Unbounded } : {}),
          statusSink: {
            publish(event: { type: string }) {
              statuses.push(event.type);
            },
          },
        },
        resolved: model,
        resolveModel: () => model,
        retry,
        runtime,
      };
      await assert.rejects(
        async () => {
          if (mode === "generate") await runGenerateText(input);
          else
            for await (const event of runStreamText({ ...input, streamIdleTimeoutMs: 1000 }))
              events.push(event);
        },
        (error: unknown) => {
          const failure = error as { code: string; context: Record<string, unknown> };
          assert.equal(failure.code, "invalid_model_response");
          assert.equal(failure.context.retryable, false);
          assert.equal(failure.context.retryDisposition, "exhausted");
          assert.equal(failure.context.retryBudgetExhausted, true);
          return true;
        },
      );
      assert.equal(calls, 2);
      assert.equal(successes, 0);
      assert.equal(statuses.filter((type) => type === "model_request_completed").length, 0);
      assert.equal(
        events.some((event) => event.type === "finish"),
        false,
      );
    });
  }

test("normal stop, refusal and reasoning-only budget completions retain their semantics", () => {
  const empty = {
    finishReason: "length",
    textLength: 0,
    reasoningLength: 0,
    toolCallCount: 0,
    usage: {},
  };
  assert.equal(isZeroOutputModelCompletion(empty), true);
  for (const finishReason of ["stop", "tool-calls", "content-filter"])
    assert.equal(isZeroOutputModelCompletion({ ...empty, finishReason }), false);
  assert.equal(isZeroOutputModelCompletion({ ...empty, reasoningLength: 10 }), false);
  assert.equal(
    isZeroOutputModelCompletion({ ...empty, usage: { reasoningTokens: 1, totalTokens: 0 } }),
    false,
  );
});
