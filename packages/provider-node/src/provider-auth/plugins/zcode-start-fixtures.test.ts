import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { account, fixture } from "./backport-test-support.js";

const model = "GLM-5.3-Flash";
const stream =
  [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"fixture","type":"message","role":"assistant","model":"GLM-5.3-Flash","content":[],"usage":{"input_tokens":12,"output_tokens":0}}}',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
  ].join("\n\n") + "\n\n";
const systems = [
  { name: "string", value: "Keep this coding instruction." },
  {
    name: "array",
    value: [
      { type: "text", text: "First instruction." },
      { type: "text", text: "   " },
      { type: "text", text: "Second instruction." },
    ],
  },
  { name: "large", value: "x".repeat(32 * 1024) },
  { name: "blank", value: "  " },
  { name: "absent", value: undefined },
];
function request(channel: string, system: unknown, extra: Record<string, unknown> = {}) {
  const base = channel === "zai" ? "https://api.z.ai" : "https://open.bigmodel.cn";
  return new Request(base + "/api/anthropic/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-beta": "fixture-agent-beta",
      "x-stainless-lang": "fixture-agent",
      "x-lcode-session-id": "fixture-session",
    },
    body: JSON.stringify({
      model,
      max_tokens: 128,
      system,
      messages: [{ role: "user", content: "Reply OK." }],
      stream: true,
      ...extra,
    }),
  });
}
function grant(channel: string, state: Record<string, unknown> = {}) {
  return {
    type: "oauth" as const,
    access: "fixture-jwt",
    expires: 0,
    refresh: JSON.stringify({
      site: channel,
      key: "",
      jwt: "fixture-jwt",
      device: "fixture-device",
      ...state,
    }),
  };
}

test("only ZCode advances to the recorded 0.1.24 source", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../vendor/manifest.json", import.meta.url), "utf8"),
  );
  const zcode = manifest.packages.find((p: { directory: string }) => p.directory === "zcode");
  assert.equal(zcode.version, "0.1.24");
  assert.equal(zcode.revision, "d1b65007ffd3e271fd1e4e95afc2b6965fc48538");
  assert.equal(manifest.revision, "5d5d86e2251169e0f5c0fd7a884957ac2dbe184a");
  assert.equal(manifest.packages.filter((p: { revision?: string }) => p.revision).length, 1);
});

for (const channel of ["zai", "bigmodel"]) {
  test(`${channel} bundled Start Plan preserves instructions in three blocks and streams GLM-5.3-Flash`, async (t) => {
    const f = await fixture(t, channel, ({ body }) => {
      // 修复依据：上游会拒绝第 4 段 system（405/3012），不能用无 system 的探活掩盖。
      if (JSON.parse(body).system.length !== 3)
        return {
          status: 405,
          json: { code: 3012, msg: "request has been blocked due to unusual activity." },
        };
      return { text: stream, headers: { "content-type": "text/event-stream" } };
    });
    const a = account(grant(channel));
    const signIns: string[] = [];
    let stable: unknown;
    for (const { name, value } of systems) {
      const res = await f.driver.fetch(request(channel, value), {
        ...a.context,
        reportSignIn: async (s) => {
          signIns.push(s);
        },
      });
      assert.equal(res.status, 200, name);
      assert.equal(await res.text(), stream);
      const sent = f.calls.at(-1)!;
      assert.equal(sent.path, "/api/v1/zcode-plan/anthropic/v1/messages");
      assert.equal(sent.headers["x-fixture-upstream"], "https://zcode.z.ai");
      assert.equal(sent.headers.authorization, "Bearer fixture-jwt");
      assert.equal(sent.headers["x-zcode-app-version"], "3.16.3");
      assert.equal(sent.headers["x-zcode-query-source"], "main_turn");
      assert.equal(sent.headers["anthropic-beta"], undefined);
      assert.equal(sent.headers["x-stainless-lang"], undefined);
      assert.equal(sent.headers["x-lcode-session-id"], undefined);
      const payload = JSON.parse(sent.body);
      stable ??= payload.system.slice(0, 2);
      assert.deepEqual(payload.system.slice(0, 2), stable);
      assert.equal(payload.model, model);
      assert.equal(payload.max_tokens, 128);
      assert.equal(payload.stream, true);
      assert.equal(payload.system.length, 3);
      assert.ok(payload.system.every((s: { cache_control: unknown }) => s.cache_control));
      if (typeof value === "string" && value.trim())
        assert.ok(payload.system[2].text.endsWith(value));
      if (Array.isArray(value))
        assert.ok(payload.system[2].text.endsWith("First instruction.\n\nSecond instruction."));
      assert.ok(!JSON.stringify(payload.system).includes("fixture-agent"));
    }
    assert.equal(f.calls.length, systems.length);
    assert.equal(a.writes.length, 0);
    assert.deepEqual(
      signIns,
      systems.map(() => "kept"),
    );
  });

  for (const team of [false, true])
    test(`${channel} ${team ? "team" : "personal"} Coding Plan keeps the original system and tools`, async (t) => {
      const f = await fixture(t, channel, () => ({
        text: stream,
        headers: { "content-type": "text/event-stream" },
      }));
      const a = account(
        grant(channel, {
          key: "fixture-plan-key",
          jwt: "",
          ...(team ? { org: "fixture-org", project: "fixture-project" } : {}),
        }),
      );
      const system = [{ type: "text", text: "Keep my own system." }];
      const tools = [
        {
          name: "inspect",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ];
      const res = await f.driver.fetch(
        request(channel, system, { tools, thinking: { type: "adaptive" } }),
        a.context,
      );
      assert.equal(res.status, 200);
      assert.equal(await res.text(), stream);
      const sent = f.calls.at(-1)!;
      assert.equal(sent.path, "/api/anthropic/v1/messages");
      assert.equal(
        sent.headers["x-fixture-upstream"],
        channel === "zai" ? "https://api.z.ai" : "https://open.bigmodel.cn",
      );
      assert.equal(sent.headers["x-api-key"], "fixture-plan-key");
      assert.equal(sent.headers["x-zcode-app-version"], undefined);
      const payload = JSON.parse(sent.body);
      assert.deepEqual(payload.system, system);
      assert.deepEqual(payload.tools, tools);
      assert.deepEqual(payload.thinking, { type: "adaptive" });
      assert.equal(f.calls.length, 1);
      assert.equal(a.writes.length, 0);
    });
}

test("Start Plan 405 remains a single refusal and keeps the grant", async (t) => {
  const f = await fixture(t, "zai", () => ({
    status: 405,
    json: { code: 3012, msg: "request has been blocked due to unusual activity." },
  }));
  const a = account(grant("zai"));
  const signIns: string[] = [];
  const res = await f.driver.fetch(request("zai", "Coding instruction."), {
    ...a.context,
    reportSignIn: async (s) => {
      signIns.push(s);
    },
  });
  assert.equal(res.status, 405);
  assert.match(await res.text(), /Start Plan.*turned this request away/);
  assert.deepEqual(signIns, ["kept"]);
  assert.equal(a.writes.length, 0);
  assert.equal(f.calls.length, 1);
});

test("ZCode upgrade keeps local/API method IDs and appends the team browser method", async (t) => {
  for (const channel of ["zai", "bigmodel"]) {
    const f = await fixture(t, channel, ({ path }) =>
      path === "/api/v1/oauth/cli/init"
        ? {
            json: {
              code: 0,
              data: {
                flow_id: "fixture-team",
                authorize_url: "https://login.example.invalid/authorize",
              },
            },
          }
        : { status: 503 },
    );
    const methods = await f.driver.methods();
    assert.equal(methods.find((m) => m.id === "2")?.kind, "local");
    assert.equal(methods.find((m) => m.id === "3")?.type, "api");
    assert.equal(methods.find((m) => m.id === "4")?.kind, "browser");
    assert.match(methods.find((m) => m.id === "4")!.label, /team/);
    assert.ok(methods.every((m) => !m.fields?.some((p) => p.key === "site")));
    assert.equal(f.calls.length, 0);
    const challenge = await f.driver.authorize(
      "4",
      { site: channel === "zai" ? "bigmodel" : "zai" },
      new AbortController().signal,
    );
    assert.equal(challenge.method, "auto");
    const url = new URL(challenge.url!);
    assert.ok(url.searchParams.has(channel === "zai" ? "redirect_uri" : "redirect"));
    assert.equal(JSON.parse(f.calls[0]!.body).provider, channel);
    assert.equal(f.calls.length, 1);
  }
});
