import assert from "node:assert/strict";
import test from "node:test";
import { RoutingError } from "@lcode/provider";
import { runGenerateText } from "./runner-generate.js";
import { runStreamText } from "./runner-stream.js";
import type {
  AiSdkModelRuntime,
  AiSdkStreamTextResult,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";

for (const mode of ["generate", "stream"] as const) {
  for (const dispatch of ["unsent", "uncertain"] as const) {
    test(`${mode} ${dispatch} routing denial reports feedback only for a potentially dispatched lease`, async () => {
      let reports = 0;
      const deny = () => {
        throw new RoutingError("concurrency-full", { dispatch, phase: "admission" });
      };
      const runtime: AiSdkModelRuntime = {
        async generateText() {
          return deny();
        },
        streamText: deny,
      };
      const resolved = {
        providerId: "oauth:synthetic",
        modelId: "synthetic",
        providerKind: "openai-compatible",
        model: {},
        properties: {
          contextWindow: 1024,
          inputFormat: { supportsText: true },
          outputFormat: { supportsText: true },
        },
        observeRoutingFailure: async () => {
          reports++;
        },
      } as unknown as ResolvedAiSdkModel;
      const input = {
        env: { LCODE_RUNTIME_ENV: "test" },
        modelIoFullRetentionEnabled: false,
        request: {
          messages: [{ role: "user" as const, content: "synthetic" }],
          maxOutputTokens: 32,
        },
        resolved,
        resolveModel: () => resolved,
        runtime,
        retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, backoffFactor: 1, jitter: false },
      };
      let failed = false;
      try {
        if (mode === "generate") await runGenerateText(input);
        else
          for await (const event of runStreamText({ ...input, streamIdleTimeoutMs: 1000 }))
            if (event.type === "error") failed = true;
      } catch {
        failed = true;
      }
      assert.equal(failed, true);
      assert.equal(reports, dispatch === "unsent" ? 0 : 1);
    });
  }
}

test("a stream that already committed output still reports feedback despite a contradictory unsent claim", async () => {
  let reports = 0;
  const resolved = {
    providerId: "oauth:synthetic",
    modelId: "synthetic",
    providerKind: "openai-compatible",
    model: {},
    properties: {
      contextWindow: 1024,
      inputFormat: { supportsText: true },
      outputFormat: { supportsText: true },
    },
    observeRoutingFailure: async () => {
      reports++;
    },
  } as unknown as ResolvedAiSdkModel;
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      throw Error("unused");
    },
    streamText() {
      return {
        fullStream: (async function* () {
          yield { type: "text-start", id: "text" };
          yield { type: "text-delta", id: "text", text: "visible" };
          yield {
            type: "error",
            error: new RoutingError("concurrency-full", { dispatch: "unsent" }),
          };
        })(),
      } as unknown as AiSdkStreamTextResult;
    },
  };
  const events = [];
  try {
    for await (const event of runStreamText({
      env: { LCODE_RUNTIME_ENV: "test" },
      modelIoFullRetentionEnabled: false,
      streamIdleTimeoutMs: 1000,
      request: { messages: [{ role: "user", content: "synthetic" }], maxOutputTokens: 32 },
      resolved,
      resolveModel: () => resolved,
      runtime,
      retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, backoffFactor: 1, jitter: false },
    }))
      events.push(event);
  } catch {
    /* 原失败可以抛出或投影 error；反馈不能因此丢失。 */
  }
  assert.ok(events.some((event) => event.type === "text_delta"));
  assert.equal(reports, 1);
});
