import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import { createGitAccountAuthorization } from "./gitAccountAuthorization.js";
import { gitOAuthFailure } from "./gitOAuthErrors.js";

test("OAuth failures expose fixed categories without raw URL, code, token or server descriptions", async (t) => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const redirectUri = `http://127.0.0.1:${(server.address() as { port: number }).port}/git-auth/callback`;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [failure, expected] of [
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "oauth-tls-untrusted"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "oauth-tls-hostname"],
    ["CERT_HAS_EXPIRED", "oauth-tls-expired"],
    ["ECONNREFUSED", "oauth-network"],
  ]) {
    const raw = new TypeError("private-host/?code=private-code", {
      cause: Object.assign(new Error("private-token"), { code: failure }),
    });
    assert.equal(gitOAuthFailure(raw, "oauth-network"), expected);
    const owner = createGitAccountAuthorization({
      http: async () => {
        throw raw;
      },
    });
    t.after(() => owner.dispose());
    const requestId = randomUUID();
    const started = await owner.command({
      type: "start",
      requestId,
      provider: "gitlab",
      serverUrl: "https://example.invalid",
      clientId: "fixture",
      redirectUri,
    });
    const state = new URL(started.authorizeUrl!).searchParams.get("state");
    const status = await owner.command({
      type: "callback",
      requestId,
      url: redirectUri + "?code=fixture&state=" + state,
    });
    assert.equal(status.error, expected);
    assert.equal(status.authorizeUrl, undefined);
    assert.equal(status.userCode, undefined);
    assert.equal(status.status, "failed");
    assert.ok(!JSON.stringify(status).includes("private-"));
    owner.dispose();
  }
  for (const [error, expected] of [
    ["invalid_client", "oauth-client-invalid"],
    ["invalid_grant", "oauth-code-invalid"],
    ["invalid_scope", "oauth-permission"],
  ]) {
    const owner = createGitAccountAuthorization({
      http: async () =>
        new Response(JSON.stringify({ error, error_description: "private-token" }), {
          status: 400,
        }),
    });
    t.after(() => owner.dispose());
    const requestId = randomUUID();
    const start = await owner.command({
      type: "start",
      requestId,
      provider: "gitlab",
      serverUrl: "https://example.invalid",
      clientId: "fixture",
      redirectUri,
    });
    const status = await owner.command({
      type: "callback",
      requestId,
      url:
        redirectUri +
        "?code=fixture&state=" +
        new URL(start.authorizeUrl!).searchParams.get("state"),
    });
    assert.equal(status.error, expected);
    assert.ok(!JSON.stringify(status).includes("private-token"));
    owner.dispose();
  }
});
