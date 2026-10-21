import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:https";
import { createServer as createPortServer } from "node:net";
import { once } from "node:events";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createGitManagementService } from "./gitManagementService.js";

test("Git OAuth owner uses live Host CA options for real HTTPS token/user requests and keeps failures redacted", async (t) => {
  const forge = createRequire(import.meta.url)("node-forge");
  const keys = forge.pki.rsa.generateKeyPair(2048),
    cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 60000);
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  cert.setSubject([{ name: "commonName", value: "Git OAuth fixture" }]);
  cert.setIssuer(cert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const pem = forge.pki.certificateToPem(cert),
    home = await mkdtemp(join(tmpdir(), "lcode-oauth-ca-")),
    ca = join(home, "root.pem");
  await writeFile(ca, pem);
  const paths: string[] = [];
  const server = createServer(
    { cert: pem, key: forge.pki.privateKeyToPem(keys.privateKey) },
    (req, res) => {
      paths.push(req.url!);
      req.resume();
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          req.url === "/oauth/token"
            ? { access_token: "fixture-access-secret", expires_in: 3600 }
            : { id: 9, username: "verified-user" },
        ),
      );
    },
  );
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const portServer = createPortServer();
  portServer.listen(0, "127.0.0.1");
  await once(portServer, "listening");
  const redirectUri = `http://127.0.0.1:${(portServer.address() as { port: number }).port}/git-auth/callback`;
  await new Promise<void>((resolve) => portServer.close(() => resolve()));
  let configured = false;
  const owner = createGitManagementService({
    credentials: { load: async () => null, save: async () => {}, delete: async () => {} },
    home,
    lockPath: join(home, "profile"),
    detectionCommand: null,
    credentialMetadataRunner: null,
    oauthNetworkOptions: async () => (configured ? { caCertPath: ca } : {}),
  });
  t.after(async () => {
    owner.dispose();
    for (const socket of sockets) socket.destroy();
    server.close();
    await unlink(ca);
    await rmdir(home);
  });
  const start = async () => {
    const requestId = randomUUID();
    const status = await owner.authorize({
      type: "start",
      requestId,
      provider: "gitlab",
      serverUrl: `https://127.0.0.1:${(server.address() as { port: number }).port}`,
      clientId: "fixture",
      redirectUri,
    });
    const state = new URL(status.authorizeUrl!).searchParams.get("state");
    return owner.authorize({
      type: "callback",
      requestId,
      url: redirectUri + "?code=fixture-code&state=" + state,
    });
  };
  const failed = await start();
  assert.equal(failed.error, "oauth-tls-untrusted");
  assert.deepEqual(paths, []);
  configured = true;
  const ready = await start();
  assert.equal(ready.status, "ready");
  assert.equal(ready.username, "verified-user");
  assert.deepEqual(paths, ["/oauth/token", "/api/v4/user"]);
  assert.ok(!JSON.stringify(ready).includes("secret"));
});
