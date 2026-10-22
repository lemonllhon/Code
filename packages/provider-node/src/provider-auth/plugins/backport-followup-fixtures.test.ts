import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { account, fixture } from "./backport-test-support.js";
import { normalizePluginContentRefusal } from "./content-refusal.mjs";

for (const channel of ["minimax-code", "minimax-code-global"])
  test(`${channel} bundled check-in renews through Host once and signs the new user`, async (t) => {
    const f = await fixture(t, channel, ({ path, headers }) => {
      if (path === "/oauth2/token")
        return {
          json: { access_token: "fixture-new", refresh_token: "fixture-next", expires_in: 3600 },
        };
      if (path.startsWith("/v1/api/user/info"))
        return { json: { data: { userInfo: { realUserID: "fixture-new-id" } } } };
      const url = new URL(path, "https://fixture.invalid");
      assert.equal(
        headers["x-fixture-upstream"],
        channel.endsWith("global") ? "https://agent.minimax.io" : "https://agent.minimaxi.com",
      );
      if (headers.authorization === "Bearer fixture-old")
        return { status: 401, json: { error: "invalid access token" } };
      assert.equal(headers.authorization, "Bearer fixture-new");
      assert.equal(url.searchParams.get("user_id"), "fixture-new-id");
      assert.equal(url.searchParams.get("device_platform"), "web");
      assert.ok(headers.yy);
      return {
        json: {
          base_resp: { status_code: 0 },
          data: url.pathname.endsWith("status")
            ? { days: [{ is_today: true, status: 2, points: 1, day_no: 1 }] }
            : { claim_result: 1, points: 0 },
        },
      };
    });
    const a = account({
      type: "oauth",
      access: "fixture-old",
      refresh: "fixture-refresh",
      realUserID: "fixture-old-id",
      expires: Date.now() + 3600_000,
    });
    const signIns: string[] = [];
    const result = await f.driver.checkin!({
      ...a.context,
      reportSignIn: async (state) => {
        signIns.push(state);
      },
    });
    assert.deepEqual(result, { outcome: "claimed", credit: 0, streak: 1 });
    assert.equal(a.writes.length, 1);
    assert.equal(f.calls.filter((c) => c.path === "/oauth2/token").length, 1);
    assert.equal(
      f.calls.filter((c) => c.path.startsWith("/minimax-cloud/api/v1/signin/status")).length,
      2,
    );
    assert.equal(
      f.calls.filter((c) => c.path.startsWith("/minimax-cloud/api/v1/signin/claim")).length,
      1,
    );
    assert.deepEqual(signIns, ["renewed"]);
  });

test("Kiro cold bundled API key does not spend model permit on optional GetProfile", async (t) => {
  const f = await fixture(t, "kiro", ({ path, headers, body }) => {
    if (headers["x-amz-target"] === "AmazonCodeWhispererService.GetProfile")
      return { status: 400, json: {} };
    assert.equal(path, "/generateAssistantResponse");
    assert.equal(JSON.parse(body).profileArn, undefined);
    return { status: 500, json: { message: "fixture runtime error" } };
  });
  const a = account({ type: "api", key: "fixture-key" });
  const res = await f.driver.fetch(
    new Request("https://runtime.us-east-1.kiro.dev/messages", {
      method: "POST",
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "fixture" }] }),
    }),
    a.context,
  );
  assert.equal(res.status, 500);
  await res.text();
  assert.equal(
    f.calls.filter((c) => String(c.headers["x-amz-target"] ?? "").endsWith("GetProfile")).length,
    2,
  );
  assert.equal(f.calls.filter((c) => c.path === "/generateAssistantResponse").length, 1);
  assert.equal(a.writes.length, 0);
});

test("Devin bundled large conversation sends one compressed Connect frame", async (t) => {
  const f = await fixture(t, "devin", ({ path, bytes, headers }) => {
    if (!path.includes("GetChatMessage")) return { status: 500, json: {} };
    assert.equal(headers["connect-content-encoding"], "gzip");
    assert.equal(bytes[0], 1);
    assert.equal(bytes.readUInt32BE(1), bytes.length - 5);
    assert.ok(gunzipSync(bytes.subarray(5)).includes(Buffer.from("fixture-large")));
    return { status: 500, json: {} };
  });
  const a = account({ type: "api", key: "fixture-key" });
  const model = (await f.driver.models(a.context)).find((x) => x.id === "swe-2")!;
  const res = await f.driver.fetch(
    new Request(model.baseURL + "/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: model.id,
        messages: [{ role: "user", content: "fixture-large".repeat(10000) }],
      }),
    }),
    a.context,
  );
  await res.text();
  assert.equal(f.calls.filter((c) => c.path.includes("GetChatMessage")).length, 1);
  assert.equal(a.writes.length, 0);
});

test("Factory structured content rejection is terminal before organization repair", async () => {
  const body = { error: { code: "content_policy_rejected", message: "fixture policy rejection" } };
  const raw = Response.json(body, { status: 403 });
  const res = await normalizePluginContentRefusal("factory", raw);
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("x-lcode-upstream-status"), "403");
  assert.deepEqual(await res.json(), body);
  for (const [channel, original] of [
    ["factory", Response.json({ error: { message: "content_policy_rejected" } }, { status: 403 })],
    ["factory", Response.json(body, { status: 403, headers: { "x-factory-upstream-error": "1" } })],
    ["factory", Response.json(body, { status: 401 })],
    ["grok", Response.json({ error: { code: "permission_denied" } }, { status: 403 })],
  ] as const) {
    const next = await normalizePluginContentRefusal(channel, original);
    assert.equal(next, original);
    await next.body?.cancel();
  }
});

test("Factory bundled policy refusal sends one model POST and no organization repair", async (t) => {
  const f = await fixture(t, "factory", ({ path }) => {
    assert.match(path, /\/llm\/o\//);
    return {
      status: 403,
      json: { error: { code: "content_policy_rejected", message: "fixture refusal" } },
    };
  });
  const a = account({ type: "api", key: "fixture-key", metadata: { region: "" } });
  const model = (await f.driver.models(a.context)).find((x) => x.id === "gpt-6.1-sol")!;
  const res = await f.driver.fetch(
    new Request(model.baseURL + "/responses", {
      method: "POST",
      body: JSON.stringify({ model: model.id, input: "fixture" }),
    }),
    a.context,
  );
  assert.equal(res.status, 400);
  assert.equal(
    ((await res.json()) as { error: { code: string } }).error.code,
    "content_policy_rejected",
  );
  assert.equal(f.calls.length, 1);
  assert.equal(a.writes.length, 0);
});

test("Zed bundled Anthropic projection retains tool-result prefix and notice placement", async (t) => {
  const f = await fixture(t, "zed", ({ path, body }) => {
    if (path === "/client/users/me")
      return { json: { user: { id: "fixture-user" }, plan: { plan_v3: "zed_pro" } } };
    if (path === "/client/llm_tokens") return { json: { token: "fixture-model-token" } };
    if (path === "/models")
      return {
        json: { models: [{ id: "fixture-claude", provider: "anthropic", max_token_count: 64000 }] },
      };
    assert.equal(path, "/completions");
    const messages = JSON.parse(body).provider_request.messages;
    assert.deepEqual(
      messages.map((m: { role: string }) => m.role),
      ["assistant", "user"],
    );
    assert.equal(messages[1].content[0].type, "tool_result");
    assert.equal(messages[1].content[0].is_error, false);
    assert.equal(messages[1].content[1].text, "fixture-notice");
    return { status: 500, text: "fixture stop" };
  });
  const a = account({
    type: "oauth",
    access: "fixture-access",
    refresh: JSON.stringify({ userId: "fixture-user", plan: "zed_pro" }),
  });
  const model = (await f.driver.models(a.context))[0]!;
  const res = await f.driver.fetch(
    new Request(model.baseURL + "/messages", {
      method: "POST",
      body: JSON.stringify({
        model: model.id,
        max_tokens: 100,
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: "a", name: "Git", input: {} }] },
          { role: "system", content: "fixture-notice" },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "" }] },
        ],
      }),
    }),
    a.context,
  );
  await res.text();
  assert.equal(f.calls.filter((c) => c.path === "/completions").length, 1);
});
