import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fetchPluginModel } from "../packages/provider-node/src/provider-auth/plugins/worker-fetch.mjs";
import { prepareResponses } from "../packages/provider-node/src/provider-auth/native/openai-request.ts";
import { autoRequest } from "../packages/provider-node/src/provider-auth/native/copilot-auto-request.ts";
import { geminiRequest } from "../packages/provider-node/src/provider-auth/native/google-wire.ts";
import { ClaudeTools } from "../packages/provider-node/src/provider-auth/native/claude-mcp.ts";
import { applyProviderCompatibility } from "../packages/provider-node/src/provider-auth/plugins/vendor-compatibility-patch.mjs";
import { objectToolSchema } from "../packages/provider/src/tool-schema.ts";
import { normalizeGoogleQuotaResponse } from "../packages/provider-node/src/provider-auth/native/google-quota-error.ts";
import { classifyModelFailure } from "../apps/lcode-cli/packages/adapters/src/model/failure-classifier.ts";

// 集成入口通过各包公开面读取真实工具与转换器；先构建 CLI 依赖，再运行本文件。
const sdk = createRequire(
  new URL("../apps/lcode-cli/packages/adapters/package.json", import.meta.url),
);
async function publicModule(name, key = ".") {
  const manifest = new URL(
    `../apps/lcode-cli/packages/bootstrap/node_modules/${name}/package.json`,
    import.meta.url,
  );
  const config = JSON.parse(await readFile(manifest, "utf8"));
  return import(new URL(config.exports[key].import, manifest));
}
const { builtInTools } = await publicModule("@lcode/core");
const { toAiSdkTools } = await publicModule("@lcode/adapters", "./model");
const git = builtInTools.find((tool) => tool.metadata.name === "Git");
assert.ok(git);
const original = structuredClone(git.inputSchema);
const actions = ["inspect", "bind", "fetch", "push", "ls-remote"];
function complete(schema) {
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.properties.action.enum, actions);
  for (const field of ["url", "username", "expectedRevision", "remote", "refs", "flags", "timeout"])
    assert.ok(schema.properties[field], `missing Git field ${field}`);
  assert.deepEqual(schema.required, ["action"]);
  assert.deepEqual(git.inputSchema, original);
}

const channels = [
  "bigmodel",
  "zai",
  "cline",
  "commandcode-plan",
  "cursor",
  "devin",
  "factory",
  "grok",
  "kiro",
  "minimax-code",
  "minimax-code-global",
  "mimo-app",
  "qoder",
  "qoder-cn",
  "trae-cn",
  "trae-global",
  "workbuddy",
  "workbuddy-ai",
  "zed",
  "opencode-zen-free",
];
for (const channel of channels)
  for (const protocol of ["chat/completions", "responses", "messages"]) {
    test(`${channel}/${protocol}: common worker preserves the real Git contract`, async () => {
      const tool =
        protocol === "messages"
          ? { name: "Git", input_schema: git.inputSchema }
          : protocol === "responses"
            ? { type: "function", name: "Git", parameters: git.inputSchema }
            : { type: "function", function: { name: "Git", parameters: git.inputSchema } };
      let sent;
      await fetchPluginModel({
        channel,
        hooks: {},
        provider: { id: channel, api: "https://fixture.invalid/v1" },
        loader: {
          fetch: async (request) => {
            sent = await request.json();
            return Response.json({});
          },
        },
        request: {
          url: `https://fixture.invalid/v1/${protocol}`,
          method: "POST",
          headers: [],
          body: new TextEncoder().encode(JSON.stringify({ tools: [tool] })),
        },
        signal: new AbortController().signal,
      });
      // Factory 的 Messages 由固定 vendor 对称包装/解包；不改变此入口的原联合。
      if (channel === "factory" && protocol === "messages")
        assert.deepEqual(sent.tools[0].input_schema, original);
      else
        complete(
          protocol === "messages"
            ? sent.tools[0].input_schema
            : protocol === "responses"
              ? sent.tools[0].parameters
              : sent.tools[0].function.parameters,
        );
    });
  }

test("real SDK Chat/Responses/Messages emit object roots and complete Git actions", async () => {
  const { createOpenAI } = sdk("@ai-sdk/openai");
  const { createAnthropic } = sdk("@ai-sdk/anthropic");
  const { createOpenAICompatible } = sdk("@ai-sdk/openai-compatible");
  for (const protocol of ["chat", "responses", "messages", "compatible"]) {
    let sent;
    const fetch = async (_url, init) => {
      sent = JSON.parse(init.body);
      throw new Error("fixture captured before network");
    };
    const options = { apiKey: "fixture", baseURL: "https://fixture.invalid/v1", fetch };
    const model =
      protocol === "messages"
        ? createAnthropic(options)("claude-fixture")
        : protocol === "compatible"
          ? createOpenAICompatible({ ...options, name: "fixture" })("fixture")
          : protocol === "responses"
            ? createOpenAI(options).responses("gpt-fixture")
            : createOpenAI(options).chat("gpt-fixture");
    const transformed = toAiSdkTools([{ name: "Git", inputSchema: git.inputSchema }], {
      providerKind: protocol === "messages" ? "anthropic" : "openai",
    });
    const inputSchema = await transformed.Git.inputSchema.jsonSchema;
    await assert.rejects(
      model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "fixture" }] }],
        tools: [{ type: "function", name: "Git", description: "fixture", inputSchema }],
      }),
      /fixture captured/,
    );
    complete(
      protocol === "messages"
        ? sent.tools[0].input_schema
        : protocol === "responses"
          ? sent.tools[0].parameters
          : sent.tools[0].function.parameters,
    );
  }
});

test("native Codex, ChatGPT, Copilot and Google final builders preserve real Git actions", () => {
  for (const channel of ["codex", "chatgpt-api"])
    complete(
      prepareResponses(
        { tools: [{ type: "function", name: "Git", parameters: git.inputSchema }] },
        channel,
      ).tools[0].parameters,
    );
  for (const protocol of ["openai-chat-completions", "openai-responses", "anthropic-messages"]) {
    const output = autoRequest(
      {
        messages: [],
        tools: [{ type: "function", function: { name: "Git", parameters: git.inputSchema } }],
      },
      "fixture",
      protocol,
    ).body;
    complete(
      protocol === "anthropic-messages"
        ? output.tools[0].input_schema
        : protocol === "openai-responses"
          ? output.tools[0].parameters
          : output.tools[0].function.parameters,
    );
  }
  complete(
    geminiRequest({ model: "fixture", tools: [{ name: "Git", input_schema: git.inputSchema }] })
      .tools[0].functionDeclarations[0].parameters,
  );
});

test("Claude MCP publishes object roots and leaves tool-call arguments unchanged", async (t) => {
  const bridge = new ClaudeTools([{ name: "Git", input_schema: git.inputSchema }]);
  t.after(() => bridge.dispose());
  const config = (await bridge.start()).mcpServers.lcode;
  const response = await fetch(config.url, {
    method: "POST",
    headers: { ...config.headers, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  complete((await response.json()).result.tools[0].inputSchema);
  const args = { action: "inspect", url: "https://fixture.invalid/repository" };
  const pending = fetch(config.url, {
    method: "POST",
    headers: { ...config.headers, "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "Git", arguments: args },
    }),
  });
  bridge.use("call_fixture", "Git", args);
  bridge.provide([{ type: "tool_result", tool_use_id: "call_fixture", content: "fixture-result" }]);
  assert.deepEqual((await (await pending).json()).result.content, [
    { type: "text", text: "fixture-result" },
  ]);
});

async function vendorModule(path) {
  const root = new URL("../packages/provider-node/src/provider-auth/vendor/", import.meta.url);
  let source = applyProviderCompatibility(
    path,
    await readFile(new URL(path + ".source", root), "utf8"),
  );
  for (const match of source.matchAll(/from\s*["'](\.\/[^"']+\.mjs)["']/g)) {
    const child = path.slice(0, path.lastIndexOf("/") + 1) + match[1].slice(2);
    source = source.replace(match[0], "from " + JSON.stringify(await vendorModule(child)));
  }
  return "data:text/javascript;base64," + Buffer.from(source).toString("base64");
}

test("Qoder final vendor body retains every Git action and Factory keeps its symmetric wrapper", async () => {
  const { _internal: qoder } = await import(await vendorModule("qoder/index.mjs"));
  const projected = objectToolSchema(git.inputSchema);
  const wire = qoder.qoderBody(
    {
      messages: [{ role: "user", content: "fixture" }],
      tools: [{ type: "function", function: { name: "Git", parameters: projected } }],
    },
    { id: "dfmodel", config: {} },
  );
  complete(wire.tools[0].function.parameters);
  const factory = await import(await vendorModule("factory/anthropic-tools.mjs"));
  const wrapped = factory.wrapAnthropicTools(
    JSON.stringify({ messages: [], tools: [{ name: "Git", input_schema: git.inputSchema }] }),
  );
  const schema = JSON.parse(wrapped.body).tools[0].input_schema;
  assert.equal(schema.type, "object");
  assert.ok(wrapped.names.has("Git"));
  assert.deepEqual(Object.values(schema.properties)[0], original);
});

test("real Git execution schema still rejects missing branch fields and unknown actions", () => {
  for (const input of [
    { action: "bind", url: "fixture" },
    { action: "unknown" },
    { action: "inspect", url: "fixture", username: "extra" },
  ])
    assert.equal(git.runtimeInputSchema.safeParse(input).success, false);
  for (const action of ["fetch", "push", "ls-remote"])
    assert.equal(git.runtimeInputSchema.safeParse({ action }).success, true);
});

test("Google quota classification survives the actual Messages SDK error parser", async () => {
  const { createAnthropic } = sdk("@ai-sdk/anthropic");
  const model = createAnthropic({
    apiKey: "fixture",
    baseURL: "https://fixture.invalid",
    fetch: async () =>
      normalizeGoogleQuotaResponse(
        Response.json(
          { error: { code: 429, message: "Individual quota reached. Resets in 167h 59m" } },
          { status: 429 },
        ),
      ),
  })("claude-fixture");
  await assert.rejects(
    model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "fixture" }] }] }),
    (error) => {
      const failure = classifyModelFailure(error);
      assert.equal(failure.code, "model_rate_limited");
      assert.equal(failure.retryable, false);
      return true;
    },
  );
});
