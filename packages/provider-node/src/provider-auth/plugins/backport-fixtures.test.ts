import assert from "node:assert/strict";
import test from "node:test";
import type { AuthGrant } from "../driver.js";
import { account, fixture } from "./backport-test-support.js";
const qoderGrant: AuthGrant = {
  type: "oauth",
  access: "fixture",
  refresh: "fixture",
  uid: "fixture-user",
  machineId: "fixture-machine",
  expires: Date.now() + 3600_000,
};
const qoderModels = { chat: [{ key: "fixture", enable: true, max_input_tokens: 64000 }] };
for (const channel of ["qoder", "qoder-cn"])
  for (const streaming of [false, true])
    test(`${channel} bundled busy remains 503 through single-attempt routing (${streaming})`, async (t) => {
      const busy = JSON.stringify({
        code: "403",
        message: JSON.stringify({
          code: "10605",
          message: JSON.stringify({ modelKey: "fixture", retryAfterSeconds: 12.2 }),
        }),
      });
      const f = await fixture(t, channel, ({ path }) =>
        path.includes("/model/list")
          ? { json: qoderModels }
          : streaming
            ? {
                headers: { "content-type": "text/event-stream" },
                text: "data: " + JSON.stringify({ statusCodeValue: 403, body: busy }) + "\n\n",
              }
            : { status: 403, text: busy },
      );
      const a = account(qoderGrant);
      const [model] = await f.driver.models(a.context);
      const result = await f.driver.fetch(
        new Request(model!.baseURL + "/chat/completions", {
          method: "POST",
          body: JSON.stringify({
            model: "fixture",
            messages: [{ role: "user", content: "fixture" }],
            stream: true,
          }),
        }),
        a.context,
      );
      const wire = await result.text();
      assert.equal(result.status, 503, wire + JSON.stringify(f.calls.map((call) => call.path)));
      assert.equal(result.headers.get("retry-after"), "13");
      assert.match(wire, /Qoder is busy/);
      assert.equal(f.calls.filter((call) => !call.path.includes("/model/list")).length, 1);
      assert.equal(a.writes.length, 0);
    });

test("Qoder model-list failure is 502 without an inference POST", async (t) => {
  const f = await fixture(t, "qoder", () => ({
    status: 503,
    json: { message: "fixture catalog unavailable" },
  }));
  const a = account(qoderGrant);
  const result = await f.driver.fetch(
    new Request("https://api3.qoder.sh/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "fixture", messages: [], stream: true }),
    }),
    a.context,
  );
  assert.equal(result.status, 502);
  await result.text();
  assert.ok(f.calls.every((call) => call.path.includes("/model/list")));
  assert.equal(a.writes.length, 0);
});

test("Factory bundled Responses removes sampling without adding an inference attempt", async (t) => {
  const f = await fixture(t, "factory", () => ({
    json: { id: "fixture", output: [], status: "completed" },
  }));
  const a = account({ type: "api", key: "fixture-key" });
  const model = (await f.driver.models(a.context)).find((item) => item.id === "gpt-6.1-sol")!;
  const result = await f.driver.fetch(
    new Request(model.baseURL + "/responses", {
      method: "POST",
      body: JSON.stringify({
        model: model.id,
        instructions: "You are Droid, an AI software engineering agent built by Factory.",
        input: [],
        temperature: 0.7,
        top_p: 0.9,
      }),
    }),
    a.context,
  );
  assert.equal(result.status, 200);
  await result.text();
  const posts = f.calls.filter((call) => call.path.includes("/llm/o/"));
  assert.equal(posts.length, 1);
  const sent = JSON.parse(posts[0]!.body);
  assert.equal("temperature" in sent, false);
  assert.equal("top_p" in sent, false);
});

const zedMe = {
  user: { id: "fixture-user" },
  organizations: [{ id: "team" }, { id: "personal", is_personal: true }],
  default_organization_id: "team",
  plans_by_organization: { personal: "zed_student" },
};
const zedGrant: AuthGrant = {
  type: "oauth",
  access: "fixture",
  refresh: JSON.stringify({ userId: "fixture-user", org: "team", plan: "" }),
};
test("Zed waits for the original credential owner before minting for the new organization", async (t) => {
  let release!: () => void;
  let writing!: () => void;
  const saved = new Promise<void>((resolve) => {
    writing = resolve;
  });
  const persist = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, "zed", ({ path, body }) => {
    if (path === "/client/users/me") return { json: zedMe };
    if (path === "/client/llm_tokens") {
      assert.equal(JSON.parse(body).organization_id, "personal");
      return { json: { token: "fixture-personal-model-token" } };
    }
    return { json: { models: [{ id: "fixture", provider: "anthropic", max_token_count: 64000 }] } };
  });
  const a = account(zedGrant);
  const originalWrite = a.context.write;
  a.context.write = async (next) => {
    writing();
    await persist;
    await originalWrite(next);
  };
  const pending = f.driver.models(a.context);
  await saved;
  assert.deepEqual(
    f.calls.map((call) => call.path),
    ["/client/users/me"],
  );
  release();
  assert.ok((await pending).some((model) => model.id === "fixture"));
  assert.equal(JSON.parse(String(a.grant().refresh)).org, "personal");
  assert.equal(a.writes.length, 1);
});

test("Zed rejected credential CAS cannot mint or query the selected organization's models", async (t) => {
  const f = await fixture(t, "zed", () => ({ json: zedMe }));
  const a = account(zedGrant);
  a.context.write = async () => {
    throw new Error("fixture credential CAS rejected");
  };
  await assert.rejects(f.driver.models(a.context), /CAS rejected/);
  assert.deepEqual(
    f.calls.map((call) => call.path),
    ["/client/users/me"],
  );
  assert.equal(a.grant().refresh, zedGrant.refresh);
});

test("Zed quota refresh updates organization and never invents the default organization's plan", async (t) => {
  const f = await fixture(t, "zed", () => ({ json: zedMe }));
  const a = account(zedGrant);
  await f.driver.quota!(a.context);
  assert.equal(JSON.parse(String(a.grant().refresh)).org, "personal");
  assert.equal(JSON.parse(String(a.grant().refresh)).plan, "zed_student");
  assert.ok(f.calls.every((call) => call.path === "/client/users/me"));
});

test("Zed cancelled organization lookup cannot write credentials or mint a model token", async (t) => {
  let began!: () => void, release!: () => void;
  const reading = new Promise<void>((resolve) => {
    began = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, "zed", async () => {
    began();
    await waiting;
    return { json: zedMe };
  });
  const a = account(zedGrant);
  const controller = new AbortController();
  a.context.signal = controller.signal;
  const pending = f.driver.models(a.context);
  await reading;
  controller.abort();
  release();
  await assert.rejects(pending, /abort|cancel/i);
  assert.equal(a.writes.length, 0);
  assert.deepEqual(
    f.calls.map((call) => call.path),
    ["/client/users/me"],
  );
});

test("Zed model 402 is not replayed or followed by an implicit organization switch", async (t) => {
  const f = await fixture(t, "zed", ({ path }) => {
    if (path === "/client/users/me") return { json: zedMe };
    if (path === "/client/llm_tokens") return { json: { token: "fixture-token" } };
    if (path === "/models")
      return {
        json: { models: [{ id: "fixture", provider: "anthropic", max_token_count: 64000 }] },
      };
    return { status: 402, json: { error: { message: "fixture subscription unavailable" } } };
  });
  const a = account({
    ...zedGrant,
    refresh: JSON.stringify({ userId: "fixture-user", org: "personal", plan: "zed_student" }),
  });
  const [model] = await f.driver.models(a.context);
  const result = await f.driver.fetch(
    new Request(model!.baseURL + "/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "fixture",
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "fixture" }],
      }),
    }),
    a.context,
  );
  await result.text();
  assert.equal(result.status, 402);
  assert.equal(f.calls.filter((call) => call.path === "/completions").length, 1);
  assert.equal(a.writes.length, 0);
});

test("Zen Free bundled nullable fragments retain the complete tool call", async (t) => {
  const f = await fixture(t, "opencode-zen-free", ({ path }) =>
    path.endsWith("/chat/completions")
      ? {
          headers: { "content-type": "text/event-stream" },
          text:
            [
              {
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_fixture",
                          type: "function",
                          function: { name: "Read", arguments: '{"path":' },
                        },
                      ],
                    },
                  },
                ],
              },
              {
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [{ index: 0, function: { name: null, arguments: '"fixture"}' } }],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
              },
            ]
              .map((item) => "data: " + JSON.stringify(item) + "\n\n")
              .join("") + "data: [DONE]\n\n",
        }
      : { status: 503 },
  );
  const a = account({ type: "api", key: "public" });
  const model = (await f.driver.models(a.context)).find(
    (item) => item.protocol === "openai-chat-completions",
  )!;
  const result = await f.driver.fetch(
    new Request(model.baseURL + "/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: model.id,
        messages: [{ role: "user", content: "fixture" }],
        tools: [
          {
            type: "function",
            function: { name: "Read", parameters: { type: "object", properties: {} } },
          },
        ],
        stream: true,
      }),
    }),
    a.context,
  );
  const wire = await result.text();
  assert.equal(result.status, 200);
  assert.doesNotMatch(wire, /Invalid upstream function delta/);
  assert.match(wire, /Read/);
  assert.match(wire, /fixture/);
  assert.equal(f.calls.filter((call) => call.path.endsWith("/chat/completions")).length, 1);
});

function protoFields(bytes: Buffer) {
  let offset = 0;
  const integer = () => {
    let value = 0,
      shift = 0,
      byte: number;
    do {
      byte = bytes[offset++]!;
      value += (byte & 127) * 2 ** shift;
      shift += 7;
    } while (byte & 128);
    return value;
  };
  const result: { field: number; value?: number; bytes?: Buffer }[] = [];
  while (offset < bytes.length) {
    const tag = integer(),
      wire = tag & 7,
      field = Math.floor(tag / 8);
    if (wire === 0) result.push({ field, value: integer() });
    else if (wire === 2) {
      const size = integer();
      result.push({ field, bytes: bytes.subarray(offset, offset + size) });
      offset += size;
    } else if (wire === 1 || wire === 5) offset += wire === 1 ? 8 : 4;
    else throw new Error("Unexpected fixture protobuf field");
  }
  return result;
}
test("Devin bundled request carries an inline screenshot on the tool result", async (t) => {
  const f = await fixture(t, "devin", () => ({
    status: 503,
    json: { code: "unavailable", message: "fixture unavailable" },
  }));
  const a = account({ type: "api", key: "fixture-key" });
  const model = (await f.driver.models(a.context)).find((item) => item.id === "swe-2")!;
  const result = await f.driver.fetch(
    new Request(model.baseURL + "/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: model.id,
        messages: [
          { role: "user", content: "shot" },
          {
            role: "assistant",
            tool_calls: [
              { id: "call_fixture", type: "function", function: { name: "Read", arguments: "{}" } },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_fixture",
            content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
          },
        ],
      }),
    }),
    a.context,
  );
  await result.text();
  const calls = f.calls.filter((call) => call.path.endsWith("/GetChatMessage"));
  assert.equal(calls.length, 1);
  const messages = protoFields(calls[0]!.bytes.subarray(5))
    .filter((item) => item.field === 3)
    .map((item) => protoFields(item.bytes!));
  const tool = messages.find((message) =>
    message.some((item) => item.field === 7 && item.bytes?.toString() === "call_fixture"),
  );
  assert.ok(tool?.some((item) => item.field === 2 && item.value === 4));
  assert.equal(tool?.filter((item) => item.field === 10).length, 1);
  assert.equal(
    messages.filter((message) => message.some((item) => item.field === 2 && item.value === 1))
      .length,
    1,
  );
});
