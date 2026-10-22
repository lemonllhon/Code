import assert from "node:assert/strict";
import test from "node:test";
import { loadPatchedVendor as load } from "./vendor-test-support.ts";

test("WorkBuddy preserves international credit units, explicit zero and unknown", async () => {
  const { _internal: m } = await load("workbuddy/index.mjs");
  for (const [credits, rate] of [
    ["x0.34 credits", 0.34],
    [" X0.59 CREDIT ", 0.59],
    ["x0.00 credits", 0],
    ["x1.62", 1.62],
  ])
    assert.deepEqual(m.priceOf({ id: "fixture", credits }), { free: rate === 0, rate });
  for (const credits of [undefined, "", "unknown", "-1 credits", "NaN credits"])
    assert.deepEqual(m.priceOf({ id: "fixture", credits }), {});
});

test("Factory removes unsupported sampling even when Droid instructions already match", async () => {
  const { _internal: m } = await load("factory/index.mjs");
  const input = {
    model: "gpt-6.1-sol",
    instructions: m.DROID_LINE,
    input: [],
    temperature: 0.7,
    top_p: 0.9,
  };
  const result = JSON.parse(m.droidBody("/api/llm/o/v1/responses", JSON.stringify(input)));
  assert.equal("temperature" in result, false);
  assert.equal("top_p" in result, false);
  assert.deepEqual(input.input, result.input);
  assert.equal(result.instructions, input.instructions);
  for (const model of ["grok-4.7", "fixture-unknown"])
    assert.equal(
      JSON.parse(m.droidBody("/api/llm/o/v1/responses", JSON.stringify({ ...input, model })))
        .temperature,
      0.7,
    );
  assert.equal(m.droidBody("/other/responses", JSON.stringify(input)), JSON.stringify(input));
});

for (const status of [401, 403, 502])
  test(`Qoder classifies wrapped busy ${status} without expiring sign-in`, async () => {
    const { _internal: m } = await load("qoder/index.mjs");
    const inner = JSON.stringify({
      code: "10605",
      message: JSON.stringify({ modelKey: "fixture", retryAfterSeconds: 12.2 }),
    });
    for (const outer of [undefined, "401", "403"])
      assert.deepEqual(
        m.failure(status, "\uFEFF " + JSON.stringify({ code: outer, message: inner }) + "\n"),
        {
          status: 503,
          message: "Qoder is busy for fixture; try again in 13s",
          retryAfter: 13,
          signIn: "",
        },
      );
    assert.equal(m.failure(401, JSON.stringify({ code: "105", message: inner })).status, 401);
    assert.equal(
      m.failure(400, JSON.stringify({ code: "107", message: inner })).status === 503,
      false,
    );
  });

test("Qoder streaming text tolerates BOM and whitespace around its JSON body", async () => {
  const { _internal: m } = await load("qoder/index.mjs");
  const body = new Response(
    "data: " +
      JSON.stringify({
        statusCodeValue: 200,
        body: '\uFEFF {"choices":[{"delta":{"content":"fixture"}}]} \n',
      }) +
      "\n\n",
  ).body;
  const events = [];
  for await (const event of m.events(body)) events.push(event);
  assert.ok(JSON.stringify(events).includes("fixture"));
});

const policy = { declared: new Set(["Read"]), injected: new Set() };
function stream(chunks) {
  return new Response(
    chunks.map((chunk) => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}
const part = (fn, finish_reason = null) => ({
  choices: [
    {
      index: 0,
      delta: { tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: fn }] },
      finish_reason,
    },
  ],
});
for (const value of [null, undefined])
  test(`Zen Free retains function fragments with nullable ${value} fields`, async () => {
    const { guardToolResponse } = await load("zen-free/tool-response.mjs");
    const result = await guardToolResponse(
      stream([
        part({ name: "Read", arguments: '{"path":' }),
        part({ name: value, arguments: value }),
        part({ name: value, arguments: '"fixture"}' }, "tool_calls"),
      ]),
      "chat",
      policy,
    );
    const wire = await result.text();
    assert.doesNotMatch(wire, /Invalid upstream function delta/);
    const deltas = wire
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .flatMap((line) => JSON.parse(line.slice(6)).choices ?? []);
    const call = deltas
      .flatMap((item) => item.delta?.tool_calls ?? [])
      .find((item) => item.function?.name === "Read");
    assert.ok(call);
    assert.deepEqual(JSON.parse(call.function.arguments), { path: "fixture" });
  });
for (const invalid of [7, {}, []])
  test(`Zen Free rejects invalid function fragment ${JSON.stringify(invalid)}`, async () => {
    const { guardToolResponse } = await load("zen-free/tool-response.mjs");
    const result = await guardToolResponse(
      stream([part({ name: "Read", arguments: invalid }, "tool_calls")]),
      "chat",
      policy,
    );
    assert.match(await result.text(), /Invalid upstream function delta/);
  });

test("Zed chooses a usable organization and preserves the current usable choice", async () => {
  const { _internal: m } = await load("zed/index.mjs");
  const me = {
    organizations: [{ id: "team" }, { id: "personal", is_personal: true }, { id: "other" }],
    default_organization_id: "team",
    plans_by_organization: { personal: "zed_student", other: "zed_business" },
  };
  assert.equal(m.orgOf(me), "personal");
  assert.equal(m.orgOf(me, "other"), "other");
  me.configuration_by_organization = { personal: { is_zed_model_provider_enabled: false } };
  assert.equal(m.orgOf(me), "other");
  me.plans_by_organization = { team: "zed_free" };
  assert.equal(m.orgOf(me), "team");
  assert.equal(m.orgOf(me, "personal"), "personal");
});

test("Devin keeps tool images with their declared result and leaves user images alone", async () => {
  const { _internal: m } = await load("devin/index.mjs");
  const image = (data) => ({
    type: "image_url",
    image_url: { url: "data:image/png;base64," + data },
  });
  const input = {
    messages: [
      { role: "user", content: "shot" },
      {
        role: "assistant",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "Read", arguments: "{}" } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: "result\n\n[The tool returned an image; it follows in the next message.]",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "[From the result of Read (tool call call_1):]" },
          image("AAAA"),
          { type: "text", text: "my image" },
          image("BBBB"),
        ],
      },
    ],
  };
  const original = structuredClone(input);
  const messages = m
    .fields(m.build(input, "swe-2", "fixture-key"))
    .filter((f) => f.num === 3 && f.wire === 2)
    .map((f) => {
      const fields = m.fields(f.data);
      return {
        role: fields.find((v) => v.num === 2)?.n,
        text: new TextDecoder().decode(fields.find((v) => v.num === 3)?.data ?? new Uint8Array()),
        images: fields.filter((v) => v.num === 10).length,
      };
    });
  assert.deepEqual(
    messages.map((v) => v.role),
    [1, 2, 4, 1],
  );
  assert.equal(messages[2].text, "result");
  assert.equal(messages[2].images, 1);
  assert.equal(messages[3].text, "my image");
  assert.equal(messages[3].images, 1);
  assert.deepEqual(input, original);
});

test("Devin pairs multiple results once and preserves incomplete image notes and unmatched user input", async () => {
  const { _internal: m } = await load("devin/index.mjs");
  const image = (data) => ({
    type: "image_url",
    image_url: { url: "data:image/png;base64," + data },
  });
  const input = {
    messages: [
      { role: "user", content: "shot" },
      {
        role: "assistant",
        tool_calls: ["one", "two"].map((id) => ({
          id,
          type: "function",
          function: { name: "Read", arguments: "{}" },
        })),
      },
      {
        role: "tool",
        tool_call_id: "one",
        content: "two images\n\n[The tool returned 2 images; they follow in the next message.]",
      },
      { role: "tool", tool_call_id: "two", content: [image("BBBB")] },
      { role: "tool", tool_call_id: "one", content: "duplicate result" },
      { role: "tool", tool_call_id: "orphan", content: [image("ORPHAN")] },
      {
        role: "user",
        content: [
          { type: "text", text: "[From the result of tool call one:]" },
          image("AAAA"),
          { type: "text", text: "[From the result of tool call unknown:]" },
          image("CCCC"),
        ],
      },
    ],
  };
  const before = structuredClone(input);
  const wire = m.build(input, "swe-2", "fixture");
  const messages = m
    .fields(wire)
    .filter((v) => v.num === 3 && v.wire === 2)
    .map((v) => m.fields(v.data));
  const tools = messages.filter((v) => v.some((f) => f.num === 2 && f.n === 4));
  assert.deepEqual(
    tools.map((v) => v.filter((f) => f.num === 10).length),
    [1, 1],
  );
  assert.match(new TextDecoder().decode(tools[0].find((f) => f.num === 3).data), /2 images/);
  const user = messages.at(-1);
  assert.equal(user.filter((f) => f.num === 10).length, 1);
  assert.match(new TextDecoder().decode(user.find((f) => f.num === 3).data), /unknown/);
  assert.doesNotMatch(Buffer.from(wire).toString("utf8"), /duplicate result|ORPHAN/);
  assert.deepEqual(input, before);
});

test("Zen Free cancellation still reaches an unfinished upstream with nullable fragments", async () => {
  const { guardToolResponse } = await load("zen-free/tool-response.mjs");
  let reason;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'data: {"choices":[{"index":0,"delta":{"content":"fixture"}}]}\n\n',
        ),
      );
      controller.enqueue(
        new TextEncoder().encode(
          "data: " + JSON.stringify(part({ name: "Read", arguments: null })) + "\n\n",
        ),
      );
    },
    cancel(value) {
      reason = value;
    },
  });
  const result = await guardToolResponse(
    new Response(body, { headers: { "content-type": "text/event-stream" } }),
    "chat",
    policy,
  );
  const reader = result.body.getReader();
  assert.equal((await reader.read()).done, false);
  await reader.cancel("fixture-stop");
  assert.equal(reason, "fixture-stop");
});
