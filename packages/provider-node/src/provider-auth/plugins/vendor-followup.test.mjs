import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { loadPatchedVendor } from "./vendor-test-support.js";
import { checkinWithLoader } from "./checkin.mjs";
import { isPluginAuxiliaryRequest } from "./auxiliary-request.js";

for (const region of [undefined, "eu-central-1"])
  test(`Kiro key treats profile as optional region hint (${region ?? "none"})`, async (t) => {
    const { KiroAuthPlugin } = await loadPatchedVendor("kiro/index.mjs");
    const seen = [];
    t.mock.method(globalThis, "fetch", async (input, init) => {
      const url = new URL(input),
        h = new Headers(init.headers),
        body = JSON.parse(init.body);
      seen.push({ url, h, body });
      if (url.pathname === "/generateAssistantResponse") return Response.json({}, { status: 500 });
      assert.equal(init.method, "POST");
      assert.equal(h.get("tokentype"), "API_KEY");
      const target = h.get("x-amz-target");
      if (target?.endsWith("GetProfile"))
        return region && url.hostname.includes(region)
          ? Response.json({
              profile: { arn: `arn:aws:codewhisperer:${region}:fixture:profile/test` },
            })
          : Response.json({}, { status: 400 });
      assert.equal(url.pathname, "/");
      assert.equal(url.searchParams.get("origin"), "KIRO_CLI");
      assert.equal(body.profileArn, undefined);
      if (target?.endsWith("ListAvailableModels"))
        return Response.json({
          models: [
            { modelId: body.nextToken ? "fixture-next" : "fixture-first", modelName: "Fixture" },
          ],
          ...(body.nextToken ? {} : { nextToken: "next" }),
        });
      return Response.json({
        subscriptionInfo: { subscriptionTitle: "KIRO PRO" },
        usageBreakdownList: [],
      });
    });
    const auth = { type: "api", key: "fixture-key" };
    const hooks = await KiroAuthPlugin({
      client: { auth: { set: () => assert.fail("API key must not write credentials") } },
    });
    const models = await hooks.provider.models({ id: "kiro", models: {} }, { auth });
    assert.ok(models["fixture-first"] && models["fixture-next"]);
    await hooks.auth.usage(async () => auth);
    const loader = await hooks.auth.loader(async () => auth);
    await (
      await loader.fetch("https://fixture.invalid/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
      })
    ).text();
    const chat = seen.find((x) => x.url.pathname === "/generateAssistantResponse");
    assert.ok(chat);
    assert.equal(chat.body.profileArn, undefined);
    assert.ok(chat.url.hostname.includes(region ?? "us-east-1"));
    assert.equal(seen.filter((x) => x.h.get("x-amz-target")?.endsWith("GetProfile")).length, 2);
  });

test("Kiro auxiliary exemption requires exact host, root, method and target", () => {
  const input = "https://management.us-east-1.kiro.dev/?origin=KIRO_CLI";
  const init = {
    method: "POST",
    headers: { "x-amz-target": "AmazonCodeWhispererService.GetProfile", tokentype: "API_KEY" },
  };
  assert.equal(isPluginAuxiliaryRequest("kiro", input, init), true);
  for (const [channel, url, options] of [
    ["kiro", input.replace("management.", "runtime."), init],
    ["kiro", input.replace("/?", "/generateAssistantResponse?"), init],
    ["kiro", input, { ...init, method: "GET" }],
    [
      "kiro",
      input,
      { ...init, headers: { ...init.headers, "x-amz-target": "GenerateAssistantResponse" } },
    ],
    ["kiro", input.replace("https:", "http:"), init],
    ["grok", input, init],
  ])
    assert.equal(isPluginAuxiliaryRequest(channel, url, options), false);
});

for (const channel of ["minimax-code", "minimax-code-global"])
  for (const status of [200, 401, 403])
    test(`${channel} native check-in signs account identity and renews only 401 (${status})`, async (t) => {
      const module = await loadPatchedVendor("minimax/index.mjs");
      let auth = {
        type: "oauth",
        access: "fixture-old",
        refresh: `fixture-refresh-${channel}-${status}`,
        realUserID: "fixture-id",
        expires: Date.now() + 3600_000,
      };
      const writes = [],
        seen = [];
      t.mock.method(globalThis, "fetch", async (input, init = {}) => {
        const url = new URL(input),
          headers = new Headers(init.headers);
        seen.push({ url, headers });
        if (url.pathname === "/oauth2/token")
          return Response.json({
            access_token: "fixture-new",
            refresh_token: "fixture-next",
            expires_in: 3600,
          });
        if (url.pathname === "/v1/api/user/info")
          return Response.json({ data: { userInfo: { realUserID: "fixture-new-id" } } });
        assert.equal(
          url.origin,
          channel.endsWith("global") ? "https://agent.minimax.io" : "https://agent.minimaxi.com",
        );
        assert.equal(url.searchParams.get("device_platform"), "web");
        assert.equal(url.searchParams.get("is_desktop"), "1");
        assert.equal(url.searchParams.get("desktop_version"), "0.6.12");
        assert.equal(
          url.searchParams.get("user_id"),
          headers.get("authorization") === "Bearer fixture-new" ? "fixture-new-id" : "fixture-id",
        );
        assert.match(headers.get("yy"), /^[a-f0-9]{32}$/);
        if (headers.get("authorization") === "Bearer fixture-old" && status !== 200)
          return Response.json({ error: "invalid access token" }, { status });
        return Response.json({
          base_resp: { status_code: 0 },
          data: url.pathname.endsWith("status")
            ? { days: [{ is_today: true, status: 2, points: 2, day_no: 1 }] }
            : { claim_result: 1, points: 0, day_no: 1 },
        });
      });
      const create = channel.endsWith("global")
        ? module.MiniMaxCodeGlobalAuthPlugin
        : module.MiniMaxCodeAuthPlugin;
      const hooks = await create({
        client: {
          auth: {
            set: async ({ body }) => {
              writes.push(body);
              auth = body;
            },
          },
        },
      });
      assert.equal(typeof hooks.auth.checkin, "function");
      const result = await hooks.auth.checkin(async () => auth);
      assert.equal(result.outcome, status === 403 ? "failed" : "claimed");
      assert.equal(writes.length, status === 401 ? 1 : 0);
      assert.equal(
        seen.filter((x) => x.url.pathname.endsWith("claim")).length,
        status === 403 ? 0 : 1,
      );
      if (result.outcome === "claimed") assert.equal(result.credit, 0);
      assert.doesNotMatch(
        JSON.stringify(result),
        /fixture-old|fixture-refresh|fixture-new-id|Bearer/,
      );
    });

for (const [base, extra, expected] of [
  [undefined, 12, 12],
  [0, 12, 12],
  [2, 12, 14],
  [undefined, 0, 0],
  [undefined, undefined, undefined],
])
  test(`Trae check-in retains extra reward (${base}, ${extra})`, async () => {
    let call = 0;
    const result = await checkinWithLoader(
      "trae-cn",
      {
        fetch: async () =>
          Response.json(
            ++call === 1
              ? { code: 0, enable: true, checked_in: false }
              : { code: 0, credits: base, extra_credits: extra },
          ),
      },
      new AbortController().signal,
    );
    assert.equal(result.credit, expected);
  });

test("Zed projects inline system notices after tool results without changing source messages", async () => {
  const { _internal: z } = await loadPatchedVendor("zed/index.mjs");
  const source = [
    { role: "assistant", content: [{ type: "tool_use", id: "a", name: "Git", input: {} }] },
    { role: "system", content: "notice" },
    { role: "system", content: "" },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a", content: "" },
        { type: "text", text: "task" },
      ],
    },
    { role: "system", content: "tail" },
  ];
  const before = structuredClone(source);
  const { req } = z.providerRequest("anthropic", { messages: source, stream: true }, "fixture");
  assert.deepEqual(source, before);
  assert.equal(req.messages.length, 2);
  assert.equal(req.messages[1].role, "user");
  assert.deepEqual(
    req.messages[1].content.map((b) => (b.type === "text" ? b.text : b.type)),
    ["tool_result", "notice", "task", "tail"],
  );
  assert.equal(req.messages[1].content[0].is_error, false);
});

for (const size of [8191, 8192, 8193, 1_000_000])
  test(`Devin Connect compression boundary ${size}`, async () => {
    const { encodeConnectRequest } = await loadPatchedVendor("devin/index.mjs", [
      "encodeConnectRequest",
    ]);
    const raw = Buffer.alloc(size, 120),
      encoded = await encodeConnectRequest(raw);
    assert.equal(encoded.body[0], size > 8192 ? 1 : 0);
    assert.equal(encoded.body.readUInt32BE(1), encoded.body.length - 5);
    assert.equal(encoded.headers["Connect-Content-Encoding"], size > 8192 ? "gzip" : undefined);
    assert.deepEqual(
      size > 8192 ? gunzipSync(encoded.body.subarray(5)) : encoded.body.subarray(5),
      raw,
    );
  });

for (const mode of [
  "missing-user",
  "invalid-grant",
  "still-refused",
  "oversized",
  "upstream-error",
])
  test(`MiniMax check-in stops safely on ${mode}`, { timeout: 5000 }, async (t) => {
    const { MiniMaxCodeGlobalAuthPlugin } = await loadPatchedVendor("minimax/index.mjs");
    let auth = {
      type: "oauth",
      access: "fixture-old",
      refresh: "fixture-" + mode,
      expires: Date.now() + 3600_000,
      ...(mode === "missing-user" ? {} : { realUserID: "fixture-id" }),
    };
    let panels = 0,
      refreshes = 0,
      cancelled = 0;
    t.mock.method(globalThis, "fetch", async (input) => {
      const path = new URL(input).pathname;
      if (path === "/oauth2/token") {
        refreshes++;
        return mode === "invalid-grant"
          ? Response.json({ error: "invalid_grant" }, { status: 400 })
          : Response.json({
              access_token: "fixture-new",
              refresh_token: "fixture-next-" + mode,
              expires_in: 3600,
            });
      }
      if (path === "/v1/api/user/info")
        return Response.json({
          data: { userInfo: mode === "missing-user" ? {} : { realUserID: "fixture-new-id" } },
        });
      assert.ok(path.endsWith("/status"));
      panels++;
      if (mode === "oversized" || mode === "upstream-error")
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(1024 * 1024 + 1));
            },
            cancel() {
              cancelled++;
            },
          }),
          { status: mode === "upstream-error" ? 500 : 200 },
        );
      return Response.json({ error: "invalid access token" }, { status: 401 });
    });
    const hooks = await MiniMaxCodeGlobalAuthPlugin({
      client: {
        auth: {
          set: async ({ body }) => {
            auth = body;
          },
        },
      },
    });
    const result = await hooks.auth.checkin(async () => auth);
    assert.equal(result.outcome, "failed");
    assert.equal(panels, mode === "missing-user" ? 0 : mode === "still-refused" ? 2 : 1);
    assert.equal(refreshes, ["invalid-grant", "still-refused"].includes(mode) ? 1 : 0);
    assert.equal(result.signIn, mode === "invalid-grant" ? "expired" : undefined);
    if (mode === "oversized" || mode === "upstream-error") assert.equal(cancelled, 1);
  });
