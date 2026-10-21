import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createServer } from "node:https";
import { once } from "node:events";
import { createHostApiNetworkTransport } from "./network-transport.js";

test("OS CA policy is opt-in, validates real TLS names, and isolates connection pools", async (t) => {
  const forge = createRequire(new URL("../../services/package.json", import.meta.url))(
    "node-forge",
  );
  const keys = forge.pki.rsa.generateKeyPair(2048),
    cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 60000);
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  cert.setSubject([{ name: "commonName", value: "OS trust fixture" }]);
  cert.setIssuer(cert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const pem = forge.pki.certificateToPem(cert);
  const server = createServer(
    { cert: pem, key: forge.pki.privateKeyToPem(keys.privateKey) },
    (_req, res) => res.end("trusted"),
  );
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let useSystemCa = false;
  let reads = 0;
  const transport = createHostApiNetworkTransport(async () => ({ useSystemCa }), {
    systemCaCertificates: () => {
      reads++;
      return [pem];
    },
  });
  t.after(async () => {
    transport.dispose();
    for (const socket of sockets) socket.destroy();
    server.close();
    await transport.disposeAndWait();
  });
  const url = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  await assert.rejects(transport.fetch(url));
  assert.equal(reads, 0);
  useSystemCa = true;
  assert.equal(await (await transport.fetch(url)).text(), "trusted");
  assert.equal(reads, 1);
  await assert.rejects(transport.fetch(url.replace("127.0.0.1", "localhost")), (error) =>
    String((error as Error & { cause?: { code?: string } }).cause?.code).includes("ALTNAME"),
  );
  useSystemCa = false;
  await assert.rejects(transport.fetch(url));
});
