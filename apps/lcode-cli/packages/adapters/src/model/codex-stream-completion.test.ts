import assert from "node:assert/strict";
import test from "node:test";
import { streamText, wrapLanguageModel } from "ai";
import {
  createRootTraceContext,
  runWithModelInvocationContext,
  type Logger,
} from "@lcode/contracts";
import { createRegistryProviderConfig, parseProviderConfig } from "@lcode/provider";
import { AiSdkModelExecution } from "./model-execution.js";
import { withCodexStreamCompletion } from "./codex-stream-completion.js";

const usage = { input_tokens: 2, output_tokens: 1, total_tokens: 3 };
const completed = (output: unknown[] = []) => ({
  type: "response.completed",
  response: { id: "response-fixture", output, usage },
});
const message = (id = "message-fixture", text = "hello") => ({
  type: "message",
  id,
  role: "assistant",
  phase: "final_answer",
  content: [{ type: "output_text", text, annotations: [] }],
});
const added = (id = "message-fixture") => ({
  type: "response.output_item.added",
  output_index: 0,
  item: { ...message(id), content: [] },
});
const done = (id = "message-fixture", text = "hello") => ({
  type: "response.output_item.done",
  output_index: 0,
  item: message(id, text),
});
const delta = (id = "message-fixture", text = "hello") => ({
  type: "response.output_text.delta",
  item_id: id,
  output_index: 0,
  content_index: 0,
  delta: text,
});

function fixture(events: unknown[], access: "oauth" | "api" = "oauth", logger?: Logger) {
  let calls = 0;
  const execution = new AiSdkModelExecution(
    { env: {} },
    {
      logger,
      transport: async () => {
        calls++;
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    },
  );
  const parsed = createRegistryProviderConfig(
    parseProviderConfig({
      group: "standard-personal",
      access:
        access === "oauth"
          ? { type: "oauth-account", channelId: "codex" }
          : {
              type: "api-key",
              apiKey: "synthetic-key",
            },
      api: { type: "openai-responses", baseUrl: "https://provider.invalid/v1" },
    }),
  );
  assert.ok(parsed.ok);
  const binding = execution.bindModel({
    providerId: "fixture",
    modelId: "fixture-model",
    providerConfig: parsed.config,
    supportsJsonSchemaOutput: false,
    optionSpecs: { reasoningLevel: { map: "{}" }, maxOutputTokens: { map: "{}" } },
  });
  const resolved = binding.resolveRequest({
    options: { reasoningLevel: "low", maxOutputTokens: 64 },
    ...(access === "oauth"
      ? {
          requestAuth: {
            apiKey: "synthetic-ticket",
            baseURL: "http://127.0.0.1:19731/v1",
            protocol: "openai-responses" as const,
          },
        }
      : {}),
  });
  return {
    model: resolved.model as Parameters<typeof wrapLanguageModel>[0]["model"],
    calls: () => calls,
    close: () => execution.disposeAndWait(),
  };
}

async function collect(h: ReturnType<typeof fixture>, includeRawChunks = false) {
  const result = await h.model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    includeRawChunks,
  });
  const parts = [];
  for await (const part of result.stream) parts.push(part);
  return parts;
}

test("Codex final message without text deltas reaches the actual SDK consumer once", async () => {
  const h = fixture([added(), done(), completed([message()])]);
  try {
    const result = streamText({ model: h.model, prompt: "hi", maxRetries: 0 });
    assert.equal(await result.text, "hello");
    assert.equal((await result.totalUsage).outputTokens, 1);
    assert.equal(await result.finishReason, "stop");
    assert.equal(h.calls(), 1);
  } finally {
    await h.close();
  }
});

test("Codex completed output alone creates valid text boundaries and preserves phase", async () => {
  const h = fixture([completed([message()])]);
  try {
    const parts = await collect(h);
    assert.deepEqual(
      parts.filter((p) => p.type.startsWith("text-")).map((p) => p.type),
      ["text-start", "text-delta", "text-end"],
    );
    const text = parts.find((p) => p.type === "text-delta");
    assert.equal(text?.delta, "hello");
    assert.equal(text?.providerMetadata?.openai?.phase, "final_answer");
    assert.equal(
      parts.some((p) => p.type === "raw"),
      false,
    );
  } finally {
    await h.close();
  }
});

test("streamed text is not duplicated or extended from final snapshots", async () => {
  for (const finalText of ["hello", "hello extra"]) {
    const h = fixture([
      added(),
      delta(),
      done("message-fixture", finalText),
      completed([message()]),
    ]);
    try {
      const parts = await collect(h);
      assert.deepEqual(
        parts.filter((p) => p.type === "text-delta").map((p) => p.delta),
        ["hello"],
      );
      assert.equal(parts.filter((p) => p.type === "text-start").length, 1);
      assert.equal(parts.filter((p) => p.type === "text-end").length, 1);
    } finally {
      await h.close();
    }
  }
});

test("final text is isolated per message and per concurrent call on a binding", async () => {
  const h = fixture([
    added(),
    delta(),
    done(),
    done("second", "world"),
    completed([message(), message("second", "world")]),
  ]);
  try {
    const results = await Promise.all([collect(h), collect(h)]);
    for (const parts of results) {
      assert.deepEqual(
        parts.filter((p) => p.type === "text-delta").map((p) => p.delta),
        ["hello", "world"],
      );
    }
    assert.equal(h.calls(), 2);
  } finally {
    await h.close();
  }
});

test("tool calls, usage and upstream errors keep the SDK contract", async () => {
  const tool = {
    type: "function_call",
    id: "function-fixture",
    call_id: "call-fixture",
    name: "fixture",
    arguments: '{"value":1}',
    status: "completed",
  };
  const h = fixture([
    { type: "response.output_item.added", output_index: 0, item: { ...tool, arguments: "" } },
    { type: "response.output_item.done", output_index: 0, item: tool },
    completed([tool]),
  ]);
  try {
    const parts = await collect(h, true);
    const call = parts.find((p) => p.type === "tool-call");
    assert.equal(call?.toolCallId, "call-fixture");
    assert.equal(call?.input, '{"value":1}');
    assert.equal(parts.filter((p) => p.type === "tool-call").length, 1);
    assert.equal(parts.filter((p) => p.type === "raw").length, 3);
    assert.equal(parts.find((p) => p.type === "finish")?.finishReason.unified, "tool-calls");
  } finally {
    await h.close();
  }
  const failed = fixture([
    {
      type: "response.failed",
      sequence_number: 1,
      response: {
        status: "failed",
        error: { code: "unsupported_model", message: "synthetic upstream failure" },
      },
    },
  ]);
  try {
    await assert.rejects(collect(failed), /synthetic upstream failure/);
  } finally {
    await failed.close();
  }
});

test("API Key Responses binding retains its existing stream behavior", async () => {
  const h = fixture([added(), done(), completed([message()])], "api");
  try {
    const parts = await collect(h);
    assert.equal(
      parts.some((p) => p.type === "text-delta"),
      false,
    );
  } finally {
    await h.close();
  }
});

test("empty Codex diagnostics contain only fixed counts and trace association", async () => {
  const logs: unknown[] = [];
  const logger: Logger = {
    child: () => logger,
    debug() {},
    info() {},
    error() {},
    warn: (message, context) => {
      logs.push({ message, context });
    },
  };
  const trace = createRootTraceContext();
  const h = fixture(
    [{ type: "response.metadata", privateField: "synthetic-private-body" }, completed()],
    "oauth",
    logger,
  );
  try {
    await runWithModelInvocationContext({ traceContext: trace }, () => collect(h));
    const serialized = JSON.stringify(logs);
    assert.match(serialized, /model.codex.stream.no_output/);
    assert.match(serialized, new RegExp(trace.traceId));
    assert.equal(serialized.includes("synthetic-private-body"), false);
    assert.equal(serialized.includes("synthetic-ticket"), false);
    assert.equal(serialized.includes("127.0.0.1"), false);
  } finally {
    await h.close();
  }
});

test("Codex stream cancellation reaches the original source without new inference", async () => {
  let cancelled: unknown;
  let calls = 0;
  const source: Parameters<typeof wrapLanguageModel>[0]["model"] = {
    specificationVersion: "v3",
    modelId: "fixture",
    provider: "fixture",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("unexpected generate");
    },
    doStream: async (params) => {
      calls++;
      assert.equal(params.includeRawChunks, true);
      return {
        stream: new ReadableStream({
          cancel: (reason) => {
            cancelled = reason;
          },
        }),
      };
    },
  };
  const result = await withCodexStreamCompletion(source).doStream({ prompt: [] });
  await result.stream.cancel("user stopped");
  assert.equal(cancelled, "user stopped");
  assert.equal(calls, 1);
});
