import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { loadPatchedVendor as load, sseData } from "./vendor-test-support.ts";

const model = { key: "fixture", config: { key: "fixture" }, context: 1000000 };
const call = (id, name = "Read") => ({
  ...(id ? { id } : {}),
  type: "function",
  function: { name, arguments: "{}" },
});
const tool = (id, content = "fixture result") => ({
  role: "tool",
  ...(id ? { tool_call_id: id } : {}),
  content,
});
const assistant = (...calls) => ({ role: "assistant", content: "", tool_calls: calls });
const user = { role: "user", content: "fixture" };
async function qoder() {
  return (await load("qoder/index.mjs"))._internal;
}

for (const ids of [
  [undefined, "result"],
  [undefined, undefined],
  ["known", undefined],
])
  test(`Qoder pairs missing IDs without mutating history: ${JSON.stringify(ids)}`, async () => {
    const m = await qoder();
    const input = [user, assistant(call(ids[0])), tool(ids[1])];
    const before = structuredClone(input);
    const convert = () => m.qoderBody({ messages: input }, model).messages;
    const out = convert();
    const sent = out.find((x) => x.tool_calls);
    assert.equal(out.find((x) => x.role === "tool")?.tool_call_id, sent.tool_calls[0].id);
    assert.deepEqual(convert(), out);
    assert.deepEqual(input, before);
  });

test("Qoder protects explicit results, unknown IDs, duplicate results and turn boundaries", async () => {
  const m = await qoder();
  const convert = (messages) => m.qoderBody({ messages }, model).messages;
  const out = convert([
    user,
    assistant(call("a"), call("b")),
    tool(undefined, "B"),
    tool("a", "A"),
  ]);
  assert.deepEqual(
    out.filter((x) => x.role === "tool").map((x) => x.tool_call_id),
    ["b", "a"],
  );
  for (const tail of [
    [tool("unknown")],
    [user, tool("a")],
    [{ role: "assistant", content: "done" }, tool("a")],
  ]) {
    const broken = convert([user, assistant(call("a")), ...tail]);
    assert.equal(
      broken.some((x) => x.role === "tool"),
      false,
    );
    assert.equal(
      broken.some((x) => x.tool_calls?.length),
      false,
    );
    assert.match(JSON.stringify(broken), /Previous tool call without a matched result/);
  }
  const duplicate = convert([user, assistant(call("a"), call("b")), tool("a"), tool("a")]);
  assert.deepEqual(
    duplicate.filter((x) => x.role === "tool").map((x) => x.tool_call_id),
    ["a"],
  );
  const missing = convert([user, assistant(call("a"), call(undefined)), tool("a"), tool("a")]);
  assert.deepEqual(
    missing.filter((x) => x.role === "tool").map((x) => x.tool_call_id),
    ["a"],
  );
});

test("Qoder cache is explicit-session scoped, request IDs change, and inputs stay intact", async () => {
  const m = await qoder();
  const messages = [user];
  const input = { prompt_cache_key: "fixture-session-a", messages };
  const before = structuredClone(input);
  const a = m.qoderBody(input, model),
    b = m.qoderBody(
      { ...input, messages: [...messages, { role: "assistant", content: "ok" }, user] },
      model,
    );
  assert.equal(a.session_id, b.session_id);
  assert.notEqual(a.request_id, b.request_id);
  assert.equal(a.request_set_id, a.request_id);
  assert.notEqual(
    a.session_id,
    m.qoderBody({ ...input, prompt_cache_key: "fixture-session-b" }, model).session_id,
  );
  assert.notEqual(
    m.qoderBody({ messages, user: "same-user" }, model).session_id,
    m.qoderBody({ messages, user: "same-user" }, model).session_id,
  );
  assert.equal(a.messages.at(-1).content.at(-1).cache_control.type, "ephemeral");
  assert.deepEqual(a.messages.at(-1).contents, a.messages.at(-1).content);
  assert.doesNotMatch(JSON.stringify(a), /fixture-session-a/);
  const toolEnd = m.qoderBody(
    { ...input, messages: [user, assistant(call("a")), tool("a")] },
    model,
  );
  assert.doesNotMatch(JSON.stringify(toolEnd.messages), /cache_control/);
  assert.deepEqual(input, before);
});

for (const platform of ["win32", "darwin", "linux"])
  test(`Qoder runtime discovery ${platform} honors override, install and CLI fallback`, async (t) => {
    const m = await qoder();
    const dir = await mkdtemp(join(tmpdir(), "lcode-qoder-runtime-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const home = join(dir, "home"),
      local = join(dir, "local"),
      opt = join(dir, "opt");
    const env = { LOCALAPPDATA: local, QODER_CONFIG_DIR: join(dir, "config") };
    const name = platform === "win32" ? "runtime-info.exe" : "runtime-info";
    const path =
      platform === "win32"
        ? join(local, "Programs", "Qoder", "resources", "umid", name)
        : platform === "darwin"
          ? join(home, "Applications", "Qoder.app", "Contents", "Resources", "umid", name)
          : join(opt, "Qoder", "resources", "umid", name);
    const opts = {
      home,
      env,
      platform,
      arch: "arm64",
      opt,
      applications: join(dir, "Applications"),
    };
    const override = join(dir, "override", name);
    assert.equal(
      await m.campaignRuntime({ ...opts, env: { ...env, QODER_RUNTIME_INFO: override } }),
      override,
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "fixture");
    assert.equal(await m.campaignRuntime(opts), path);
    await rm(path);
    const cached =
      platform === "win32"
        ? join(env.QODER_CONFIG_DIR, ".bin", "umid-win32-arm64-fixture", name)
        : join(env.QODER_CONFIG_DIR, ".bin", `runtime-info-${platform}-arm64-fixture`);
    await mkdir(dirname(cached), { recursive: true });
    await writeFile(cached, "fixture");
    assert.equal(await m.campaignRuntime(opts), cached);
  });
for (const key of ["ProgramFiles", "PROGRAMFILES", "ProgramW6432"])
  test(`Qoder finds Windows global installation through ${key}`, async (t) => {
    const m = await qoder(),
      dir = await mkdtemp(join(tmpdir(), "lcode-qoder-global-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "global", "Qoder", "resources", "umid", "runtime-info.exe");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "fixture");
    assert.equal(
      await m.campaignRuntime({
        home: join(dir, "home"),
        env: { LOCALAPPDATA: join(dir, "local"), [key]: join(dir, "global") },
        platform: "win32",
      }),
      path,
    );
  });

for (const empty of [null, "", undefined])
  test(`Zen Free preserves IDs across choices and late ID fragments: ${String(empty)}`, async () => {
    const { guardToolResponse } = await load("zen-free/tool-response.mjs");
    const event = (index, delta, finish_reason = null) => ({
      choices: [{ index, delta, finish_reason }],
    });
    const chunks = [
      event(0, {
        tool_calls: [
          { index: 0, ...call("a") },
          { index: 1, ...call(undefined) },
        ],
      }),
      event(1, { tool_calls: [{ index: 0, ...call("other") }] }),
      event(0, {
        tool_calls: [
          { index: 0, id: empty },
          { index: 1, id: "late" },
        ],
      }),
      event(1, { tool_calls: [{ index: 0, id: empty }] }),
      event(0, {}, "tool_calls"),
      event(1, {}, "tool_calls"),
    ];
    const wire = chunks.map((x) => `data: ${JSON.stringify(x)}\n\n`).join("") + "data: [DONE]\n\n";
    const r = await guardToolResponse(
      new Response(wire, { headers: { "content-type": "text/event-stream" } }),
      "chat",
      { declared: new Set(["Read"]), injected: new Set() },
    );
    const values = sseData(await r.text());
    assert.ok(!values.some((x) => x.error));
    const choices = values.flatMap((x) => x.choices ?? []);
    const ids = (index) =>
      choices
        .filter((x) => x.index === index)
        .flatMap((x) => (x.delta?.tool_calls ?? []).map((c) => c.id));
    assert.deepEqual(ids(0), ["a", "late"]);
    assert.deepEqual(ids(1), ["other"]);
  });

for (const streaming of [false, true])
  test(`Devin rejects usage-only before 200, keeps text/reasoning/tools (${streaming})`, async (t) => {
    const { _internal: m } = await load("devin/index.mjs");
    const real = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = real;
    });
    const usage = new m.PB().bytes(7, new m.PB().varint(2, 10).varint(3, 2).done()).done();
    const inputs = [
      { kind: "usage", data: usage, status: 502 },
      { kind: "text", data: new m.PB().str(3, "fixture").done(), status: 200 },
      { kind: "reasoning", data: new m.PB().str(9, "fixture").done(), status: 200 },
      {
        kind: "tool",
        data: new m.PB().bytes(6, new m.PB().str(1, "a").str(2, "Read").str(3, "{}").done()).done(),
        status: 200,
      },
    ];
    let posts = 0;
    for (const fixture of inputs) {
      globalThis.fetch = async () => {
        posts++;
        return new Response(m.frame(fixture.data));
      };
      const response = await m.complete(
        { key: "fixture", server: "https://fixture.invalid", families: m.familiesOf(m.SNAPSHOT) },
        { model: "swe-2", stream: streaming, messages: [user] },
      );
      const body = await response.text();
      assert.equal(response.status, fixture.status, fixture.kind);
      if (fixture.kind === "usage") assert.match(body, /empty reply/);
      else assert.match(body, /fixture|Read/);
      assert.equal(response.headers.get("x-magpie-sign-in"), "kept");
    }
    assert.equal(posts, inputs.length);
  });

for (const array of [false, true])
  test(`Factory keeps instructions following a billing header (${array})`, async () => {
    const m = await load("factory/index.mjs", ["anthropicBody"]);
    const text = "x-anthropic-billing-header: cc_version=fixture\nKeep the task instructions.";
    const system = array ? [{ type: "text", text, cache_control: { type: "ephemeral" } }] : text;
    const out = JSON.parse(m.anthropicBody(JSON.stringify({ system, messages: [user] })));
    assert.match(JSON.stringify(out.system), /Keep the task instructions/);
    assert.doesNotMatch(JSON.stringify(out.system), /cc_version/);
    if (array) assert.equal(out.system.at(-1).cache_control.type, "ephemeral");
  });

test("Grok drops tool_choice only after all tools are absent or filtered", async () => {
  const { _internal: m } = await load("grok/index.mjs");
  for (const tools of [undefined, [], [{ type: "custom", name: "fixture" }]]) {
    const out = JSON.parse(m.rewrite(JSON.stringify({ input: [], tools, tool_choice: "none" })));
    assert.equal("tool_choice" in out, false);
  }
  const valid = JSON.stringify({
    tools: [{ type: "function", name: "Read", parameters: { type: "object" } }],
    tool_choice: "required",
  });
  assert.equal(JSON.parse(m.rewrite(valid)).tool_choice, "required");
});

test("Zen Free rejects non-string tool IDs instead of producing an invalid call", async () => {
  const { guardToolResponse } = await load("zen-free/tool-response.mjs");
  for (const id of [7, {}, []]) {
    const chunk = {
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, ...call("a"), id }] },
          finish_reason: "tool_calls",
        },
      ],
    };
    const r = await guardToolResponse(
      new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      }),
      "chat",
      { declared: new Set(["Read"]), injected: new Set() },
    );
    assert.match(await r.text(), /Invalid upstream tool ID/);
  }
});

test("Qoder schema errors remain terminal 400 despite the upstream prefix", async () => {
  const m = await qoder();
  assert.equal(
    m.failure(400, "Error in upstream response: Invalid schema for function 'Git': type null")
      .status,
    400,
  );
});

for (const stream of [false, true])
  test(
    `Devin closes a live reader on metadata-only or first-frame failure (${stream})`,
    { timeout: 2000 },
    async (t) => {
      const { _internal: m } = await load("devin/index.mjs");
      const real = globalThis.fetch;
      t.after(() => {
        globalThis.fetch = real;
      });
      for (const error of [false, true]) {
        const end = m.frame(
          new TextEncoder().encode(
            JSON.stringify(
              error ? { error: { code: "invalid_argument", message: "fixture rejection" } } : {},
            ),
          ),
        );
        end[0] = 2;
        const usage = m.frame(new m.PB().bytes(7, new m.PB().varint(2, 10).done()).done());
        let cancelled = 0;
        const raw = new ReadableStream({
          start(controller) {
            controller.enqueue(error ? end : Buffer.concat([usage, end]));
          },
          cancel() {
            cancelled++;
          },
        });
        globalThis.fetch = async () => new Response(raw);
        const response = await m.complete(
          { key: "fixture", server: "https://fixture.invalid", families: m.familiesOf(m.SNAPSHOT) },
          { model: "swe-2", stream, messages: [user] },
        );
        assert.equal(response.status, error ? 400 : 502);
        await response.text();
        assert.equal(cancelled, 1);
        assert.equal(raw.locked, false);
      }
    },
  );

test(
  "Devin cancellation interrupts an outstanding frame read and releases its reader",
  { timeout: 2000 },
  async (t) => {
    const { _internal: m } = await load("devin/index.mjs");
    const real = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = real;
    });
    let cancelled = 0;
    const raw = new ReadableStream({
      start(controller) {
        controller.enqueue(m.frame(new m.PB().str(3, "fixture").done()));
      },
      cancel() {
        cancelled++;
      },
    });
    globalThis.fetch = async () => new Response(raw);
    const response = await m.complete(
      { key: "fixture", server: "https://fixture.invalid", families: m.familiesOf(m.SNAPSHOT) },
      { model: "swe-2", stream: true, messages: [user] },
    );
    const reader = response.body.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done || new TextDecoder().decode(chunk.value).includes('"content":"fixture"'))
        break;
    }
    const pending = reader.read();
    await reader.cancel();
    assert.equal((await pending).done, true);
    assert.equal(cancelled, 1);
    assert.equal(raw.locked, false);
  },
);
