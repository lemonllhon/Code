import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { account, fixture } from "./backport-test-support.js";
import { loadPatchedVendor } from "./vendor-test-support.js";

const user = { role: "user", content: "same prompt" };
const grant = {
  type: "oauth" as const,
  access: "fixture-old",
  refresh: "fixture-refresh",
  uid: "fixture-user",
  machineId: "fixture-machine",
  expires: Date.now() + 3600000,
};
for (const channel of ["qoder", "qoder-cn"])
  test(`${channel} Host turn identity survives tool loops and compaction, separates new tasks and remote/workspace identity`, async (t) => {
    const { _internal: m } = await loadPatchedVendor("qoder/index.mjs");
    const f = await fixture(t, channel, ({ path }) =>
      path.includes("/model/list")
        ? { json: { chat: [{ key: "fixture", enable: true, max_input_tokens: 64000 }] } }
        : { status: 400, json: { message: "fixture schema rejection" } },
    );
    const a = account(grant);
    const [model] = await f.driver.models(a.context);
    const bodies = [];
    for (const [session, turn, messages] of [
      ["workspace-a/remote-a/session", "turn-a", [user]],
      ["workspace-a/remote-a/session", "turn-a", [user, { role: "assistant", content: "working" }]],
      ["workspace-a/remote-a/session", "turn-a", [{ role: "system", content: "compacted" }, user]],
      ["workspace-a/remote-a/session", "turn-b", [user]],
      ["workspace-a/remote-b/session", "turn-a", [user]],
      ["workspace-b/remote-a/session", "turn-a", [user]],
    ] as const) {
      const res = await f.driver.fetch(
        new Request(model!.baseURL + "/chat/completions", {
          method: "POST",
          body: JSON.stringify({
            model: model!.id,
            messages,
            __lcode_task_key: "untrusted",
            stream: true,
          }),
        }),
        { ...a.context, requestSessionKey: session, requestTurnKey: turn },
      );
      assert.equal(res.status, 400);
      await res.text();
      const body = JSON.parse(m.decodeBody(f.calls.at(-1)!.body));
      assert.equal(body.__lcode_task_key, undefined);
      bodies.push(body);
    }
    assert.equal(bodies[0].request_set_id, bodies[1].request_set_id);
    assert.equal(bodies[0].request_set_id, bodies[2].request_set_id);
    assert.equal(bodies[0].business.begin_at, bodies[2].business.begin_at);
    assert.equal(bodies[0].request_set_id, bodies[0].business.id);
    assert.equal(new Set(bodies.map((body) => body.request_id)).size, 6);
    assert.equal(new Set(bodies.map((body) => body.request_set_id)).size, 4);
    assert.equal(new Set(bodies.map((body) => body.session_id)).size, 3);
  });

test("Qoder CN and international check-in choose their own device helper/environment; task cache remains bounded", async () => {
  const { _internal: m } = await loadPatchedVendor("qoder/index.mjs");
  assert.equal(m.RUNTIMES.qoder.environment, "3");
  assert.equal(m.RUNTIMES["qoder-cn"].environment, "0");
  for (const id of ["qoder", "qoder-cn"]) {
    const runtime = m.RUNTIMES[id];
    const path = join(tmpdir(), `${id}-fixture-runtime`);
    assert.equal(await m.campaignRuntime({ runtime, env: { [runtime.override]: path } }), path);
  }
  m.TASKS.clear();
  for (let i = 0; i < m.TASK_MAX + 3; i++) m.taskOf("session", { __lcode_task_key: String(i) }, i);
  assert.equal(m.TASKS.size, m.TASK_MAX);
  m.taskOf("session", { __lcode_task_key: "later" }, m.TASK_IDLE + 1000);
  assert.equal(m.TASKS.size, 1);
});

for (const channel of ["workbuddy", "workbuddy-ai"])
  test(`${channel} 401 renews through Host once and returns the original inference response`, async (t) => {
    const f = await fixture(t, channel, ({ path }) =>
      path === "/v2/plugin/auth/token/refresh"
        ? {
            json: {
              code: 0,
              data: {
                accessToken: "fixture-next",
                refreshToken: "fixture-rotated",
                expiresIn: 3600,
              },
            },
          }
        : {
            status: 401,
            json: { error: "fixture refused" },
            headers: { "www-authenticate": 'Bearer error="invalid_token"', "retry-after": "7" },
          },
    );
    const a = account(grant);
    const model = (await f.driver.models(a.context))[0]!;
    const res = await f.driver.fetch(
      new Request(model.baseURL + "/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: model.id, messages: [user] }),
      }),
      a.context,
    );
    assert.equal(res.status, 401);
    assert.match(await res.text(), /fixture refused/);
    assert.equal(res.headers.get("retry-after"), "7");
    assert.equal(f.calls.filter((call) => call.path.endsWith("/chat/completions")).length, 1);
    assert.equal(f.calls.filter((call) => call.path === "/v2/plugin/auth/token/refresh").length, 1);
    assert.equal(a.writes.length, 1);
    assert.equal(a.grant().access, "fixture-next");
  });

test("Grok accepts a CLI-renewed token after 401, commits through Host and spends one inference permit", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "lcode-grok-renewal-"));
  t.after(async () => {
    const target = await realpath(home);
    assert.ok(target.startsWith((await realpath(tmpdir())) + sep));
    await rm(target, { recursive: true, force: true });
  });
  // Fixture files stay under the OS temp directory; no real CLI home is read or changed.
  const expires = Date.now() + 3600000;
  const save = (key: string) =>
    writeFile(
      join(home, "auth.json"),
      JSON.stringify({
        fixture: {
          key,
          expires_at: new Date(expires).toISOString(),
          email: "fixture@example.test",
        },
      }),
    );
  await save("fixture-old");
  const f = await fixture(t, "grok", async () => {
    await save("fixture-next");
    return { status: 401, json: { error: "fixture refused" } };
  });
  const a = account({ type: "oauth", access: "fixture-old", refresh: home, expires });
  const res = await f.driver.fetch(
    new Request("https://cli-chat-proxy.grok.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "grok-4", input: "fixture" }),
    }),
    a.context,
  );
  assert.equal(res.status, 401);
  assert.match(await res.text(), /fixture refused/);
  assert.equal(f.calls.filter((call) => call.path.endsWith("/responses")).length, 1);
  assert.equal(a.grant().access, "fixture-next");
});

test("Trae recognizes fragmented Qwen/Anthropic calls only for declared tools, leaving examples intact", async () => {
  const { _internal: m } = await loadPatchedVendor("trae/index.mjs");
  const tools = [
    {
      type: "function",
      function: {
        name: "Read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    },
  ];
  const read = (text: string, size: number) => {
    const parser = new m.TextTools(tools);
    const out = {
      text: "",
      calls: [] as { name: string; arguments: string }[],
      error: null as unknown,
    };
    for (let i = 0; i <= text.length; i += size) {
      const part = parser.push(text.slice(i, i + size), i + size > text.length);
      out.text += part.text;
      out.calls.push(...part.calls);
      if (part.error) out.error = part.error;
    }
    return out;
  };
  const calls = [
    "<function=Read><parameter=path>file.ts</parameter></function>",
    '<function_calls><invoke name="Read"><parameter name="path">file.ts</parameter></invoke></function_calls>',
  ];
  for (const size of [1, 3, 7, 2048])
    for (const text of calls) {
      const result = read(text, size);
      assert.equal(result.error, null);
      assert.equal(result.calls.length, 1);
      assert.equal(result.calls[0]!.name, "Read");
      assert.deepEqual(JSON.parse(result.calls[0]!.arguments), { path: "file.ts" });
    }
  for (const text of [
    "<function=Unknown><parameter=path>file.ts</parameter></function>",
    "Example:\n```xml\n" + calls[1] + "\n```\n",
  ]) {
    const result = read(text, 1);
    assert.deepEqual(result.calls, []);
    assert.equal(result.text, text);
  }
  const bad = read(calls[1]!.slice(0, -30), 1);
  assert.equal(bad.calls.length, 0);
  assert.match(String(bad.error), /cut short/);
});

test("Trae preserves model-specific effort names and Command Code sends off only where supported", async (t) => {
  const { _internal: m } = await loadPatchedVendor("trae/index.mjs");
  const levels = m.levelsOf({
    reasoning_effort_config: { options: ["light", "high", "extra_high"] },
  });
  assert.deepEqual(Object.keys(m.variantsOf(levels)), ["low", "high", "xhigh"]);
  const req = (effort: string) => ({
    model: "fixture",
    messages: [user],
    reasoning_effort: effort,
  });
  assert.equal(
    m.chatBody(req("low"), "chat_v3", "", 0, null, "s", false, levels).reasoning_effort,
    "light",
  );
  assert.equal(
    m.chatBody(req("xhigh"), "chat_v3", "", 0, null, "s", false, levels).reasoning_effort,
    "extra_high",
  );
  assert.equal(
    m.chatBody(req("high"), "chat_v3", "", 0, null, "s", false, []).reasoning_effort,
    undefined,
  );
  const f = await fixture(t, "commandcode", () => ({ json: { choices: [] } }));
  const a = account({ type: "api", key: "fixture", metadata: { plan: "GOAT" } });
  for (const [model, effort, expected] of [
    ["deepseek/deepseek-v4.1-flash", "none", "off"],
    ["deepseek/deepseek-v4.1-flash", "off", "off"],
    ["moonshotai/Kimi-K3", "off", undefined],
    ["deepseek/deepseek-v4-flash-fast", "none", undefined],
    ["deepseek/deepseek-v4-flash-fast", "max", "max"],
  ]) {
    const response = await f.driver.fetch(
      new Request("https://api.commandcode.ai/provider/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model, reasoning_effort: effort, messages: [user] }),
      }),
      a.context,
    );
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(JSON.parse(f.calls.at(-1)!.body).reasoning_effort, expected);
  }
});
