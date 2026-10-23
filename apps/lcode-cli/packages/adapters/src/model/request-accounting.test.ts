import { createPhysicalRequestAccounting, type ModelNetworkStatusEvent } from "@lcode/contracts";
import assert from "node:assert/strict";
import test from "node:test";
import { runGenerateText } from "./runner-generate.js";
import type { AiSdkModelRuntime, ResolvedAiSdkModel } from "./runner-runtime.js";
import { runStreamText } from "./runner-stream.js";

const resolved = {
  model: {},
  modelId: "fixture",
  providerId: "fixture",
  providerKind: "openai-compatible",
  properties: {
    contextWindow: 100,
    inputFormat: { text: true },
    outputFormat: { text: true },
    supportsToolCall: true,
  },
} as unknown as ResolvedAiSdkModel;

for (const transport of ["generate", "stream"] as const) {
  for (const cancelAt of ["started", "retry-yield"] as const) {
    test(`${transport} ${cancelAt} before provider invocation does not consume physical budget`, async () => {
      let sent = 0,
        evaluations = 0;
      const controller = new AbortController();
      const accounting = createPhysicalRequestAccounting({
        maxRequests: 3,
        maxReservedTokens: 360,
      });
      const runtime = {
        generateText() {
          sent++;
          throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
        },
        streamText() {
          sent++;
          throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
        },
      } as unknown as AiSdkModelRuntime;
      const input = {
        env: { LCODE_RUNTIME_ENV: "test" },
        modelIoFullRetentionEnabled: false,
        request: {
          messages: [{ role: "user" as const, content: "synthetic" }],
          maxOutputTokens: 20,
          abortSignal: controller.signal,
          statusSink: {
            publish(event: ModelNetworkStatusEvent) {
              if (cancelAt === "started" && event.type === "model_request_started")
                controller.abort();
            },
          },
          ...(cancelAt === "retry-yield"
            ? { shouldYieldRetryToFailover: () => ++evaluations === 2 }
            : {}),
        },
        resolveModel: () => resolved,
        resolved,
        runtime,
        retry: { backoffFactor: 1, baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
        statusSink: accounting,
        physicalRequestAccounting: accounting,
        streamIdleTimeoutMs: 1000,
      };
      await assert.rejects(async () => {
        if (transport === "generate") await runGenerateText(input);
        else
          for await (const _event of runStreamText(input)) {
            /* consume boundary */
          }
      });
      const expected = cancelAt === "started" ? 0 : 1;
      assert.equal(sent, expected);
      assert.equal(accounting.snapshot().requests.length, expected);
      assert.equal(accounting.snapshot().reservedTokens, expected * 120);
    });
  }
  test(`${transport} blocks provider invocation when physical budget cannot reserve`, async () => {
    let sent = 0;
    const controller = new AbortController();
    const accounting = createPhysicalRequestAccounting(
      { maxRequests: 1, maxReservedTokens: 110 },
      () => controller.abort(),
    );
    const runtime = {
      generateText() {
        sent++;
        throw new Error("must not send");
      },
      streamText() {
        sent++;
        throw new Error("must not send");
      },
    } as unknown as AiSdkModelRuntime;
    const input = {
      env: { LCODE_RUNTIME_ENV: "test" },
      modelIoFullRetentionEnabled: false,
      request: {
        messages: [{ role: "user" as const, content: "synthetic" }],
        maxOutputTokens: 20,
        abortSignal: controller.signal,
      },
      resolveModel: () => resolved,
      resolved,
      runtime,
      retry: { backoffFactor: 1, baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 },
      statusSink: accounting,
      physicalRequestAccounting: accounting,
      streamIdleTimeoutMs: 1000,
    };
    await assert.rejects(async () => {
      if (transport === "generate") await runGenerateText(input);
      else
        for await (const _event of runStreamText(input)) {
          /* consume cancellation */
        }
    });
    assert.equal(sent, 0);
    assert.equal(accounting.snapshot().reservedTokens, 0);
  });
}
