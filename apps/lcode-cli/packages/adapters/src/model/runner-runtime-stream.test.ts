import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Output, jsonSchema } from "ai";
import { defaultRuntime } from "./runner-runtime.js";
import { AiSdkModelExecution } from "./model-execution.js";
import { runGenerateText } from "./runner-generate.js";
import {
  OAuthAccountAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  type RegistryProviderConfig,
} from "@lcode/provider";
import { createPhysicalRequestAccounting, type ModelNetworkStatusEvent } from "@lcode/contracts";

const generateStreamingText = (options: Parameters<typeof defaultRuntime.generateText>[0]) =>
  defaultRuntime.generateText(options, "sse");

async function fixture(
  t: TestContext,
  mode: "text" | "json" | "tool" | "error" | "hold" | "truncated",
) {
  const requests: Record<string, unknown>[] = [];
  let opened!: () => void, closed!: () => void;
  const started = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const disconnected = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
    requests.push(body);
    if (body.stream !== true) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "Non-stream chat request is currently not supported" },
        }),
      );
      return;
    }
    res.on("close", closed);
    res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "synthetic-stream" });
    const send = (delta: unknown, finish_reason: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    send({ role: "assistant" });
    if (mode === "tool") {
      send({
        tool_calls: [
          {
            index: 0,
            id: "call_read",
            type: "function",
            function: { name: "readFact", arguments: '{"key":"test"}' },
          },
        ],
      });
    } else {
      send({ reasoning_content: "synthetic reasoning" });
      send({ content: mode === "json" ? '{"suggestion":"补充构建说明"}' : "complete " });
      if (mode === "text") send({ content: "result" });
    }
    opened();
    if (mode === "hold") return;
    if (mode === "truncated") {
      res.end();
      return;
    }
    if (mode === "error") {
      res.write(
        `data: ${JSON.stringify({ error: { message: "synthetic stream failure", type: "server_error", code: "synthetic" } })}\n\n`,
      );
      res.end();
      return;
    }
    send({}, mode === "tool" ? "tool_calls" : "stop");
    res.write(
      `data: ${JSON.stringify({ id: "synthetic", choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const model = createOpenAICompatible({
    name: "stream-only",
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "synthetic",
    includeUsage: true,
    supportsStructuredOutputs: true,
  })("model");
  return { model, requests, started, disconnected, baseURL: `http://127.0.0.1:${address.port}/v1` };
}

test("OAuth binding selects SSE for the original generate Runner, preserving accounting and status", async (t) => {
  const f = await fixture(t, "text");
  const execution = new AiSdkModelExecution({ env: {} });
  t.after(() => execution.disposeAndWait());
  const bound = execution.bindModel({
    providerId: "oauth:synthetic",
    modelId: "model",
    supportsJsonSchemaOutput: false,
    providerConfig: new ProviderConfig({
      group: "standard-personal",
      api: new ProviderApiConfig({
        type: "openai-chat-completions",
        baseUrl: "https://oauth.invalid/v1",
      }),
      access: new OAuthAccountAccessConfig({ channelId: "synthetic" }),
    }) as RegistryProviderConfig,
    optionSpecs: { reasoningLevel: { map: "{}" }, maxOutputTokens: { map: "{}" } },
  });
  const resolveModel = () => ({
    ...bound.resolveRequest({
      options: { maxOutputTokens: 100, reasoningLevel: "medium" },
      requestAuth: { baseURL: f.baseURL, apiKey: "synthetic", protocol: "openai-chat-completions" },
    }),
    properties: {
      contextWindow: 4096,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: false,
      supportsJsonSchemaOutput: false,
      requiresMfjsToolSchema: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    },
  });
  assert.equal(bound.resolved.generateTextTransport, "sse");
  const accounting = createPhysicalRequestAccounting({ maxRequests: 1, maxReservedTokens: 10000 });
  const events: ModelNetworkStatusEvent[] = [];
  const result = await runGenerateText({
    env: { LCODE_RUNTIME_ENV: "test" },
    modelIoFullRetentionEnabled: false,
    request: {
      messages: [{ role: "user", content: "Confirm" }],
      maxOutputTokens: 100,
      metadata: { skipTranscript: true },
    },
    resolved: resolveModel(),
    resolveModel,
    runtime: defaultRuntime,
    retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, backoffFactor: 1, jitter: false },
    physicalRequestAccounting: accounting,
    statusSink: {
      publish: (event) => {
        events.push(event);
      },
    },
  });
  assert.equal(result.text, "complete result");
  assert.equal(result.usage?.totalTokens, 18);
  assert.equal(f.requests.length, 1);
  assert.equal(accounting.snapshot().requests.length, 1);
  assert.ok(
    events.some((event) => event.type === "model_request_completed" && event.transport === "sse"),
  );
});

test("default final-text generation uses one SSE POST and preserves usage, reasoning and headers", async (t) => {
  const f = await fixture(t, "text");
  const result = await generateStreamingText({
    model: f.model,
    messages: [{ role: "user", content: "Confirm a project fact" }],
    maxRetries: 0,
  });
  assert.equal(result.text, "complete result");
  assert.equal(result.reasoningText, "synthetic reasoning");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.totalUsage.totalTokens, 18);
  assert.equal(result.response.headers?.["x-request-id"], "synthetic-stream");
  assert.equal(result.steps.length, 1);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]?.stream, true);
});

test("default final-text generation preserves schema output from SSE", async (t) => {
  const f = await fixture(t, "json");
  const result = await generateStreamingText({
    model: f.model,
    messages: [{ role: "user", content: "Predict" }],
    maxRetries: 0,
    output: Output.object({
      schema: jsonSchema({
        type: "object",
        properties: { suggestion: { type: "string" } },
        required: ["suggestion"],
        additionalProperties: false,
      }),
    }),
  });
  assert.deepEqual(result.output, { suggestion: "补充构建说明" });
  assert.equal(f.requests.length, 1);
});

test("default final-text generation retains tool calls without executing them", async (t) => {
  const f = await fixture(t, "tool");
  const result = await generateStreamingText({
    model: f.model,
    messages: [{ role: "user", content: "Read" }],
    maxRetries: 0,
    tools: {
      readFact: {
        inputSchema: jsonSchema({
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
        }),
      },
    },
  });
  assert.equal(result.finishReason, "tool-calls");
  assert.equal(result.toolCalls[0]?.toolName, "readFact");
  assert.deepEqual(result.toolCalls[0]?.input, { key: "test" });
  assert.equal(result.toolResults.length, 0);
  assert.equal(f.requests.length, 1);
});

test("an SSE error after partial text rejects instead of returning partial success or replaying", async (t) => {
  const f = await fixture(t, "error");
  await assert.rejects(
    generateStreamingText({
      model: f.model,
      messages: [{ role: "user", content: "Read" }],
      maxRetries: 0,
    }),
    /synthetic stream failure/,
  );
  assert.equal(f.requests.length, 1);
});

test("EOF without provider finish cannot turn partial text into a final result", async (t) => {
  const f = await fixture(t, "truncated");
  await assert.rejects(
    generateStreamingText({
      model: f.model,
      messages: [{ role: "user", content: "Read" }],
      maxRetries: 0,
    }),
    /finish|complete|result|response/i,
  );
  assert.equal(f.requests.length, 1);
});

test(
  "cancelling final-text generation closes the physical SSE request without returning partial text",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, "hold");
    const controller = new AbortController();
    const result = generateStreamingText({
      model: f.model,
      messages: [{ role: "user", content: "Read" }],
      maxRetries: 0,
      abortSignal: controller.signal,
    });
    const rejected = assert.rejects(result, /cancel|abort/i);
    await f.started;
    controller.abort();
    await rejected;
    await f.disconnected;
    assert.equal(f.requests.length, 1);
  },
);
