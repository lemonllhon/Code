import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { createBackupCrypto } from "../adapters/backupCrypto.js";
test("fresh computer imports encrypted recovery kit and authenticates archives", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "backup-key-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keys = () =>
    generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
  const oldKeys = keys();
  const newKeys = keys();
  const old = createBackupCrypto(join(root, "old"), async () => oldKeys);
  const fresh = createBackupCrypto(join(root, "new"), async () => newKeys);
  const archive = await old.seal({ apiKey: "fixture-private" });
  await assert.rejects(fresh.open(archive.bytes), /authentication/);
  const kit = await old.exportKeys("fixture-password");
  assert.ok(!kit.includes("PRIVATE KEY"));
  await assert.rejects(fresh.importKeys(kit, "wrong"), /password/);
  await fresh.importKeys(kit, "fixture-password");
  assert.deepEqual(await fresh.open(archive.bytes), { apiKey: "fixture-private" });
  const thirdKeys = keys();
  const third = createBackupCrypto(join(root, "third"), async () => thirdKeys);
  await third.importKeys(await fresh.exportKeys("third-password"), "third-password");
  assert.deepEqual(await third.open(archive.bytes), { apiKey: "fixture-private" });
  const envelope = JSON.parse(Buffer.from(archive.bytes).toString());
  envelope.tag = Buffer.alloc(16).toString("base64");
  await assert.rejects(fresh.open(Buffer.from(JSON.stringify(envelope))), /authentication/);
});
