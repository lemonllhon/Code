import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  parseProviderConfig,
  type RegistryProviderConfig,
} from "@lcode/provider";
import { AiSdkModelExecution, createApiKeyFailoverFetch } from "./model-execution.js";
import { runGenerateText } from "./runner-generate.js";
import { defaultRuntime } from "./runner-runtime.js";

const keys = [
  { id: "bad", apiKey: "bad", enabled: true },
  { id: "good", apiKey: "good", enabled: true },
];

test("401 retries with the next key and remembers the failed key", async () => {
  const calls: string[] = [];
  const fetch = createApiKeyFailoverFetch({
    providerKind: "openai-compatible",
    keys,
    fetch: async (input) => {
      const authorization = new Request(input).headers.get("authorization") ?? "";
      calls.push(authorization);
      return authorization.endsWith("bad")
        ? new Response(null, { status: 401 })
        : new Response("ok", { status: 200 });
    },
  });
  assert.equal((await fetch("https://example.test/chat")).status, 200);
  assert.equal((await fetch("https://example.test/chat")).status, 200);
  assert.deepEqual(calls, ["Bearer bad", "Bearer good", "Bearer good"]);
});

test("a quota 403 tries the next enabled key in the same request", async () => {
  const calls: string[] = [];
  const execution = new AiSdkModelExecution(
    {},
    {
      transport: async (input) => {
        const authorization = new Request(input).headers.get("authorization") ?? "";
        calls.push(authorization);
        return authorization.endsWith("cipher-bad")
          ? new Response(
              JSON.stringify({
                error: {
                  code: "permission-denied",
                  message: "Your team has used all available credits.",
                },
              }),
              { status: 403, headers: { "content-type": "application/json" } },
            )
          : new Response(
              JSON.stringify({
                id: "cmpl",
                choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
      },
    },
  );
  const model = bindKeys(execution, "save-1");
  await generate(model);
  assert.deepEqual(calls, ["Bearer cipher-bad", "Bearer cipher-good"]);
  calls.length = 0;
  await generate(model);
  assert.deepEqual(calls, ["Bearer cipher-good"]);
});

test("a quota 403 with no next key preserves the provider response", async () => {
  const quotaMessage = "Your team has used all available credits.";
  const calls: string[] = [];
  const fetch = createApiKeyFailoverFetch({
    providerKind: "openai-compatible",
    keys: [keys[0]!],
    fetch: async (input) => {
      calls.push(new Request(input).headers.get("authorization") ?? "");
      return new Response(quotaMessage, { status: 403 });
    },
  });
  const response = await fetch("https://example.test/chat");
  assert.equal(response.status, 403);
  assert.equal(await response.text(), quotaMessage);
  assert.deepEqual(calls, ["Bearer bad"]);
});

test("exhausted keys stop after one pass and preserve the final quota error", async () => {
  const calls: string[] = [];
  const fetch = createApiKeyFailoverFetch({
    providerKind: "openai-compatible",
    keys,
    fetch: async (input) => {
      const authorization = new Request(input).headers.get("authorization") ?? "";
      calls.push(authorization);
      return new Response(`Quota exceeded: ${authorization}`, { status: 403 });
    },
  });
  const response = await fetch("https://example.test/chat");
  assert.equal(response.status, 403);
  assert.equal(await response.text(), "Quota exceeded: Bearer good");
  assert.deepEqual(calls, ["Bearer bad", "Bearer good"]);
});

test("500 does not rotate keys", async () => {
  const calls: string[] = [];
  const fetch = createApiKeyFailoverFetch({
    providerKind: "openai-compatible",
    keys,
    fetch: async (input) => {
      calls.push(new Request(input).headers.get("authorization") ?? "");
      return new Response(null, { status: 500 });
    },
  });
  assert.equal((await fetch("https://example.test/chat")).status, 500);
  assert.deepEqual(calls, ["Bearer bad"]);
});

test("successful requests round-robin enabled keys", async () => {
  const calls: string[] = [];
  const fetch = createApiKeyFailoverFetch({
    providerKind: "openai-compatible",
    keys: [
      { id: "one", apiKey: "one", enabled: true },
      { id: "two", apiKey: "two", enabled: true },
    ],
    fetch: async (input) => {
      calls.push(new Request(input).headers.get("authorization") ?? "");
      return new Response("ok");
    },
  });
  await fetch("https://example.test/chat");
  await fetch("https://example.test/chat");
  await fetch("https://example.test/chat");
  assert.deepEqual(calls, ["Bearer one", "Bearer two", "Bearer one"]);
});

const unchangedKeys = [
  { id: "bad", apiKey: "cipher-bad", enabled: true },
  { id: "good", apiKey: "cipher-good", enabled: true },
];

function providerConfig(): RegistryProviderConfig {
  return new ProviderConfig({
    group: "standard-personal",
    access: new ApiKeyAccessConfig({
      apiKey: unchangedKeys[0]?.apiKey,
      apiKeys: unchangedKeys,
    }),
    api: new ProviderApiConfig({
      type: "openai-chat-completions",
      baseUrl: "https://example.test/v1",
    }),
  }) as RegistryProviderConfig;
}

const optionSpecs = {
  reasoningLevel: { map: "{}" },
  maxOutputTokens: { map: "{}" },
};

function bindProvider(
  execution: AiSdkModelExecution,
  providerId: string,
  saveGeneration: string | undefined,
  config = providerConfig(),
  modelId = "demo",
) {
  const binding = execution.bindModel({
    providerId,
    modelId,
    providerConfig: config,
    ...(saveGeneration === undefined ? {} : { providerSaveGeneration: saveGeneration }),
    supportsJsonSchemaOutput: false,
    optionSpecs,
  });
  return () => ({
    ...binding.resolveRequest({ options: { reasoningLevel: "off", maxOutputTokens: 16 } }),
    properties: {
      contextWindow: 128,
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
}

function bindKeys(execution: AiSdkModelExecution, saveGeneration: string | undefined) {
  return bindProvider(execution, "custom", saveGeneration);
}

test("retained Coding Plan templates call Anthropic with user keys without an application subscription", async () => {
  const data = JSON.parse(
    await readFile(
      new URL("../../../../../../config/provider/lcode-builtin.json", import.meta.url),
      "utf8",
    ),
  );
  for (const id of ["zai-api", "bigmodel-api"]) {
    const template = data.config.providerConfigRules.templateRules.find(
      (entry: { templateId: string }) => entry.templateId === id,
    );
    assert.ok(template);
    const calls: Request[] = [];
    const execution = new AiSdkModelExecution(
      {},
      {
        transport: async (input) => {
          calls.push(new Request(input));
          return Response.json({
            id: "msg_fixture",
            type: "message",
            role: "assistant",
            model: "GLM-5.3",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        },
      },
    );
    const config = parseProviderConfig({
      ...template.config,
      group: "standard-personal",
      access: { ...template.config.access, apiKey: "FIXTURE_ONLY_NOT_A_REAL_API_KEY" },
    }) as RegistryProviderConfig;
    await generate(bindProvider(execution, `custom:${id}`, undefined, config, "GLM-5.3"));
    assert.equal(calls.length, 1);
    assert.equal(
      new URL(calls[0]!.url).pathname,
      id === "zai-api"
        ? "/api/v1/ultra-zai/anthropic/v1/messages"
        : "/api/v1/ultra/anthropic/v1/messages",
    );
    assert.equal(calls[0]!.headers.get("x-api-key"), "FIXTURE_ONLY_NOT_A_REAL_API_KEY");
  }
});

async function generate(resolveModel: ReturnType<typeof bindProvider>): Promise<void> {
  // 现行派发许可归 Runner；直接 doGenerate 绕过每次 Key 尝试的准入与预算，不能证明正式回退链路。
  await runGenerateText({
    env: { LCODE_RUNTIME_ENV: "test" },
    modelIoFullRetentionEnabled: false,
    request: { messages: [{ role: "user", content: "ping" }], maxOutputTokens: 16 },
    resolved: resolveModel(),
    resolveModel,
    runtime: defaultRuntime,
    retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, backoffFactor: 1, jitter: false },
  });
}

test("a new frozen save generation clears failed keys and the same generation keeps skipping", async () => {
  const calls: string[] = [];
  const execution = new AiSdkModelExecution(
    {},
    {
      transport: async (input) => {
        const authorization = new Request(input).headers.get("authorization") ?? "";
        calls.push(authorization);
        return authorization.endsWith("cipher-bad")
          ? new Response(null, { status: 401 })
          : new Response(
              JSON.stringify({
                id: "cmpl",
                choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
      },
    },
  );
  const first = bindKeys(execution, "save-1");
  await generate(first);
  assert.deepEqual(calls, ["Bearer cipher-bad", "Bearer cipher-good"]);
  calls.length = 0;
  await generate(first);
  assert.deepEqual(calls, ["Bearer cipher-good"]);

  calls.length = 0;
  const saved = bindKeys(execution, "save-2");
  await generate(saved);
  assert.deepEqual(calls, ["Bearer cipher-bad", "Bearer cipher-good"]);
  calls.length = 0;
  await generate(saved);
  assert.deepEqual(calls, ["Bearer cipher-good"]);
});

test("saving another provider keeps this provider's failed keys", async () => {
  const calls: string[] = [];
  const execution = new AiSdkModelExecution(
    {},
    {
      transport: async (input) => {
        const authorization = new Request(input).headers.get("authorization") ?? "";
        calls.push(authorization);
        return authorization.endsWith("cipher-bad")
          ? new Response(null, { status: 401 })
          : new Response(
              JSON.stringify({
                id: "cmpl",
                choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
      },
    },
  );
  const first = bindKeys(execution, "save-a");
  await generate(first);
  calls.length = 0;

  const otherProvider = bindProvider(execution, "other-provider", "save-b");
  await generate(otherProvider);
  calls.length = 0;

  await generate(first);
  assert.deepEqual(calls, ["Bearer cipher-good"]);
  calls.length = 0;
  const sameGeneration = bindKeys(execution, "save-a");
  await generate(sameGeneration);
  assert.deepEqual(calls, ["Bearer cipher-good"]);
});

test("all failed keys do not dispatch another POST", async () => {
  const calls: string[] = [];
  const execution = new AiSdkModelExecution(
    {},
    {
      transport: async (input) => {
        calls.push(new Request(input).headers.get("authorization") ?? "");
        return new Response(null, { status: 401 });
      },
    },
  );
  const model = bindKeys(execution, "save-1");
  await assert.rejects(generate(model));
  assert.deepEqual(calls, ["Bearer cipher-bad", "Bearer cipher-good"]);
  calls.length = 0;
  await assert.rejects(generate(model));
  assert.deepEqual(calls, []);
});
