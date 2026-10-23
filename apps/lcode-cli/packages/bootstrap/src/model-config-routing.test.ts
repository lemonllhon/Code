import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { createRuntimeAiSdkModelExecutionConfig } from "./model-config.js";
import { createModelAdapter } from "./model-factory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import {
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  ModelConfig,
  createRegistryModelConfig,
} from "@lcode/provider";
test("XQP-11 bootstrap shares the existing data directory and its legacy alias without IO", () => {
  const base = process.cwd();
  const expected = join(base, ".lcode", "v2", "routing-quotas-v1");
  assert.equal(
    createRuntimeAiSdkModelExecutionConfig({ LCODE_DATA_BASE_DIR: base }).routingQuotaDirectory,
    expected,
  );
  assert.equal(
    createRuntimeAiSdkModelExecutionConfig({ ZCODE_DATA_BASE_DIR: base }).routingQuotaDirectory,
    expected,
  );
});

test("SR-04 real bootstrap adapters share provider recovery and the original session resumes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "adapter-shared-routing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.now(),
    posts = 0;
  t.mock.method(Date, "now", () => now);
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    posts++;
    if (posts === 1) {
      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after-ms": "100",
        "x-lcode-rate-limit-scope": "provider",
      });
      response.end('{"error":{"message":"synthetic provider rejection"}}');
      return;
    }
    if (!body.stream) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "fixture",
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const env = { LCODE_MODEL_RETRY_MAX_RETRIES: "0" };
  const a = createModelAdapter({ executionConfig: { env, routingQuotaDirectory: directory }, env });
  const b = createModelAdapter({ executionConfig: { env, routingQuotaDirectory: directory }, env });
  t.after(() => {
    a.dispose();
    b.dispose();
  });
  const modelConfig = createRegistryModelConfig(
    ModelConfig.fromData({
      enabled: true,
      properties: {
        contextWindow: 100,
        requiresMfjsToolSchema: false,
        supportsToolCall: true,
        supportsJsonSchemaOutput: false,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: true,
        inputFormat: {
          supportsText: true,
          supportsImage: false,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: false,
        },
        outputFormat: { supportsText: true },
      },
      optionSpecs: {
        reasoningLevel: { values: ["none"], map: "{}" },
        maxOutputTokens: { max: 20, map: "{}" },
      },
    }),
  );
  assert.ok(modelConfig.ok);
  const model = (adapter: typeof a, providerId: string, poolId: string) =>
    adapter.createModel({
      providerId,
      modelId: "fixture",
      providerConfig: new ProviderConfig({
        group: "standard-personal",
        api: new ProviderApiConfig({
          type: "openai-chat-completions",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
        }),
        access: new ApiKeyAccessConfig({
          apiKeys: [{ id: "key", apiKey: "synthetic", routing: { quotaPoolId: poolId } }],
        }),
      }) as Parameters<typeof adapter.createModel>[0]["providerConfig"],
      modelConfig: modelConfig.config,
    });
  const original = model(a, "fixture", "one"),
    other = model(b, "fixture", "two");
  const request = {
    messages: [{ role: "user" as const, content: "synthetic" }],
    options: { reasoningLevel: "none", maxOutputTokens: 20 },
  };
  await assert.rejects(original.generateText(request), (error: unknown) => {
    const context = (error as { context: Record<string, unknown> }).context;
    assert.equal(context.statusCode, 429);
    assert.equal(context.reason, "rate_limited");
    return true;
  });
  for (const current of [original, other])
    await assert.rejects(current.generateText(request), /route-cooling/);
  assert.equal(
    posts,
    1,
    "all adapters must honor the shared provider gate before another HTTP request",
  );
  assert.equal((await model(b, "independent", "one").generateText(request)).text, "ok");
  now += 100;
  assert.equal(
    (await original.generateText(request)).text,
    "ok",
    "original model binding must recover",
  );
  assert.equal((await other.generateText(request)).text, "ok");
  assert.equal(posts, 4);
});
