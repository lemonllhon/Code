import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { createGitAccountAuthorization } from "./gitAccountAuthorization.js";
import { refreshGitOAuthGrant } from "./gitOAuthTransport.js";

async function callbackUri() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/git-auth/callback`;
}
const json = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
test("GitLab/Gitea PKCE validates state and callback, exchanges only on Host, and exposes no tokens", async (t) => {
  for (const provider of ["gitlab", "gitea"] as const) {
    const calls: { url: string; body: string }[] = [];
    let challenge = "";
    const owner = createGitAccountAuthorization({
      http: async (url, options) => {
        const target = String(url);
        calls.push({ url: target, body: String(options?.body ?? "") });
        assert.equal(options?.redirect, "error");
        if (target.endsWith("/oauth/token") || target.endsWith("/oauth/access_token")) {
          const body = new URLSearchParams(String(options?.body));
          assert.equal(
            createHash("sha256").update(body.get("code_verifier")!).digest("base64url"),
            challenge,
          );
          return json({
            access_token: "fixture-access-secret",
            refresh_token: "fixture-refresh-secret",
            expires_in: 3600,
          });
        }
        return json({ id: 7, login: "actual-user", username: "actual-user" });
      },
    });
    t.after(() => owner.dispose());
    const requestId = randomUUID(),
      redirectUri = await callbackUri();
    const status = await owner.command({
      type: "start",
      requestId,
      provider,
      serverUrl: "https://code.example.invalid/team",
      clientId: "fixture-client",
      redirectUri,
    });
    const authorize = new URL(status.authorizeUrl!);
    challenge = authorize.searchParams.get("code_challenge")!;
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorize.searchParams.get("redirect_uri"), redirectUri);
    await assert.rejects(
      owner.command({
        type: "callback",
        requestId,
        url: redirectUri + "?code=fixture-code&state=wrong",
      }),
      /oauth-invalid/,
    );
    assert.equal((await owner.command({ type: "poll", requestId })).status, "pending");
    const response = await fetch(
      redirectUri + "?code=fixture-code&state=" + authorize.searchParams.get("state"),
    );
    assert.equal(response.status, 200);
    const ready = await owner.command({ type: "poll", requestId });
    assert.equal(ready.status, "ready");
    assert.equal(ready.username, "actual-user");
    assert.ok(!JSON.stringify(ready).includes("secret"));
    await assert.rejects(
      owner.command({
        type: "callback",
        requestId,
        url: redirectUri + "?code=fixture-code&state=" + authorize.searchParams.get("state"),
      }),
      /oauth-invalid/,
    );
    const grant = owner.beginSave(requestId);
    assert.equal(grant.accessToken, "fixture-access-secret");
    owner.rollbackSave(requestId);
    assert.equal((await owner.command({ type: "poll", requestId })).status, "ready");
    owner.beginSave(requestId);
    owner.finishSave(requestId, randomUUID());
    assert.equal((await owner.command({ type: "poll", requestId })).status, "saved");
    assert.throws(() => owner.beginSave(requestId), /oauth-invalid/);
    assert.equal(calls.length, 2);
  }
});

test("PKCE rejects unsafe callbacks and occupied ports without losing the original pending authorization", async (t) => {
  const owner = createGitAccountAuthorization({ http: async () => json({}) });
  t.after(() => owner.dispose());
  const requestId = randomUUID(),
    redirectUri = await callbackUri(),
    start = await owner.command({
      type: "start",
      requestId,
      provider: "gitlab",
      serverUrl: "https://code.example.invalid",
      clientId: "fixture",
      redirectUri,
    });
  const state = new URL(start.authorizeUrl!).searchParams.get("state");
  for (const url of [
    redirectUri.replace("/git-auth/callback", "/wrong") + "?code=c&state=" + state,
    redirectUri + "?code=c&state=" + "中".repeat(43),
    redirectUri + "?code=c&state=" + state + "&state=extra",
  ])
    await assert.rejects(owner.command({ type: "callback", requestId, url }), /oauth-invalid/);
  const conflict = await owner.command({
    type: "start",
    requestId: randomUUID(),
    provider: "gitea",
    serverUrl: "https://forge.example.invalid",
    clientId: "fixture",
    redirectUri,
  });
  assert.equal(conflict.error, "oauth-port-in-use");
  assert.equal((await owner.command({ type: "poll", requestId })).status, "pending");
  const denied = await owner.command({
    type: "callback",
    requestId,
    url: redirectUri + "?error=access_denied&state=" + state,
  });
  assert.equal(denied.error, "oauth-denied");
});

test("GitHub device authorization honors interval/slow_down, request idempotency and expiry", async (t) => {
  let clock = 10000,
    polls = 0,
    starts = 0;
  const owner = createGitAccountAuthorization({
    now: () => clock,
    http: async (url) => {
      if (String(url).endsWith("/login/device/code")) {
        starts++;
        return json({
          device_code: "private-device",
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          expires_in: 600,
          interval: 5,
        });
      }
      if (String(url).endsWith("/user")) return json({ id: 9, login: "device-user" });
      polls++;
      return json(
        polls === 1
          ? { error: "authorization_pending" }
          : polls === 2
            ? { error: "slow_down" }
            : { access_token: "device-access-secret" },
      );
    },
  });
  t.after(() => owner.dispose());
  const request = {
    type: "start" as const,
    requestId: randomUUID(),
    provider: "github" as const,
    serverUrl: "https://github.com",
    clientId: "fixture-client",
    redirectUri: "http://127.0.0.1:17654/git-auth/callback",
  };
  const first = await owner.command(request);
  assert.equal(first.userCode, "ABCD-EFGH");
  await owner.command(request);
  assert.equal(starts, 1);
  assert.ok(!JSON.stringify(first).includes("private-device"));
  await owner.command({ type: "poll", requestId: request.requestId });
  assert.equal(polls, 0);
  clock += 5000;
  await owner.command({ type: "poll", requestId: request.requestId });
  assert.equal(polls, 1);
  clock += 5000;
  const slow = await owner.command({ type: "poll", requestId: request.requestId });
  assert.ok(slow.pollAfterMs >= 10000);
  clock += 5000;
  await owner.command({ type: "poll", requestId: request.requestId });
  assert.equal(polls, 2);
  clock += 5000;
  const ready = await owner.command({ type: "poll", requestId: request.requestId });
  assert.equal(ready.status, "ready");
  await assert.rejects(
    owner.command({ ...request, clientId: "different-client" }),
    /oauth-invalid/,
  );
  clock += 600000;
  assert.equal(
    (await owner.command({ type: "poll", requestId: request.requestId })).status,
    "expired",
  );
});

test("Cancel/denial and malformed verification targets cannot continue authorization", async (t) => {
  const owner = createGitAccountAuthorization({
    http: async (url) =>
      String(url).endsWith("/login/device/code")
        ? json({
            device_code: "device",
            user_code: "CODE",
            verification_uri: "https://evil.invalid/login",
            expires_in: 600,
            interval: 1,
          })
        : json({}),
  });
  t.after(() => owner.dispose());
  const requestId = randomUUID();
  const status = await owner.command({
    type: "start",
    requestId,
    provider: "github",
    serverUrl: "https://github.com",
    clientId: "fixture",
    redirectUri: "http://127.0.0.1:17654/git-auth/callback",
  });
  assert.equal(status.status, "failed");
  assert.equal((await owner.command({ type: "cancel", requestId })).status, "cancelled");
  assert.throws(() => owner.beginSave(requestId));
});

test("OAuth refresh rotates secrets for the same verified identity and rejects a different user", async () => {
  const grant = {
    provider: "gitlab" as const,
    serverUrl: "https://gitlab.example.invalid",
    username: "alice",
    subject: "3",
    clientId: "fixture",
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 1,
  };
  const http: typeof fetch = async (url) =>
    String(url).endsWith("/oauth/token")
      ? json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 })
      : json({ id: 3, username: "alice" });
  const next = await refreshGitOAuthGrant(http, grant);
  assert.equal(next.accessToken, "new-access");
  assert.equal(next.refreshToken, "new-refresh");
  assert.ok(next.expiresAt! > Date.now());
  await assert.rejects(
    refreshGitOAuthGrant(
      async (url) =>
        String(url).endsWith("/oauth/token")
          ? json({ access_token: "new-access" })
          : json({ id: 4, username: "bob" }),
      grant,
    ),
    /oauth-failed/,
  );
});
