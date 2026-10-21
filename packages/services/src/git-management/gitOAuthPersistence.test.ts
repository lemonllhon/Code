import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import { createCredentialService } from "../credential/credentialService.js";
import { getDataBaseDir, setDataBaseDir } from "../paths.js";
import { createGitManagementService } from "./gitManagementService.js";

test("OAuth CAS save encrypts grants, rejects forged identities, survives restart and refreshes once for concurrent commands", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "lcode-oauth-vault-")),
    previous = getDataBaseDir();
  setDataBaseDir(home);
  t.after(() => setDataBaseDir(previous));
  const portServer = createServer();
  portServer.listen(0, "127.0.0.1");
  await once(portServer, "listening");
  const redirectUri = `http://127.0.0.1:${(portServer.address() as { port: number }).port}/git-auth/callback`;
  await new Promise<void>((resolve) => portServer.close(() => resolve()));
  const json = (v: unknown) => new Response(JSON.stringify(v));
  let refreshed = 0;
  const http: typeof fetch = async (url, options) => {
    if (String(url).endsWith("/oauth/token")) {
      const body = new URLSearchParams(String(options?.body));
      if (body.get("grant_type") === "refresh_token") {
        refreshed++;
        return json({
          access_token: "rotated-access-secret",
          refresh_token: "rotated-refresh-secret",
          expires_in: 3600,
        });
      }
      return json({
        access_token: "initial-access-secret",
        refresh_token: "initial-refresh-secret",
        expires_in: 1,
      });
    }
    return json({ id: 11, username: "verified-user" });
  };
  const create = () =>
    createGitManagementService({
      home,
      credentials: createCredentialService(),
      lockPath: join(home, "profile"),
      detectionCommand: null,
      credentialMetadataRunner: null,
      oauthHttp: http,
    });
  const service = create();
  t.after(() => service.dispose());
  const requestId = randomUUID();
  const start = await service.authorize({
    type: "start",
    requestId,
    provider: "gitlab",
    serverUrl: "https://code.example.invalid",
    clientId: "fixture-client",
    redirectUri,
  });
  const state = new URL(start.authorizeUrl!).searchParams.get("state");
  await service.authorize({
    type: "callback",
    requestId,
    url: redirectUri + "?code=fixture&state=" + state,
  });
  await assert.rejects(
    service.mutate({ type: "authorize", expectedRevision: "stale", requestId, name: "OAuth user" }),
    /revision-conflict/,
  );
  assert.equal((await service.authorize({ type: "poll", requestId })).status, "ready");
  const snapshot = await service.mutate({
    type: "authorize",
    expectedRevision: "empty",
    requestId,
    name: "OAuth user",
  });
  assert.ok(!JSON.stringify(snapshot).includes("secret"));
  assert.equal(snapshot.accounts[0]!.username, "verified-user");
  const account = snapshot.accounts[0]!;
  const { revision: _revision, hasToken: _hasToken, ...accountInput } = account;
  await assert.rejects(
    service.mutate({
      type: "save",
      expectedRevision: snapshot.revision,
      account: { ...accountInput, username: "forged", token: "" },
    }),
    /oauth-invalid/,
  );
  const raw = await readFile(join(home, ".lcode/v2/credentials.json"), "utf8");
  assert.ok(raw.includes("enc:lcode:v2:"));
  assert.ok(!raw.includes("secret"));
  const restarted = create();
  t.after(() => restarted.dispose());
  const results = await Promise.all([
    restarted.authentication("https://code.example.invalid/team/r.git", {
      id: account.id,
      revision: account.revision,
    }),
    restarted.authentication("https://code.example.invalid/team/r.git", {
      id: account.id,
      revision: account.revision,
    }),
  ]);
  assert.equal(refreshed, 1);
  assert.ok(results.every((r) => r.secret === "rotated-access-secret"));
  assert.deepEqual(await restarted.getSnapshot(), snapshot);
  await assert.rejects(
    service.mutate({
      type: "authorize",
      expectedRevision: snapshot.revision,
      requestId,
      name: "Again",
    }),
    /oauth-invalid/,
  );
});
