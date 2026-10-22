import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLegacyBackupRecovery } from "./legacyBackupRecovery.js";
import { encryptBuffer } from "./gitBackupEncryption.js";
import { createBackupCrypto, type BackupObjectStore } from "../backup/node.js";
import { createGitBackupSource } from "./gitBackupRestore.js";
test("v1 cloud backup discovers, decrypts, validates legacy separators and deletes exact objects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "legacy-backup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const files = [
    { path: "HEAD", content: Buffer.from("ref: refs/heads/main\n") },
    { path: "logs\\HEAD", content: Buffer.from("fixture reflog\n") },
  ];
  const packed = Buffer.concat(
    files.flatMap((file) => [Buffer.from(`${file.path}\0${file.content.length}\0`), file.content]),
  );
  const payload = encryptBuffer(packed, pair.publicKey);
  const base = "0123456789abcdef01234567/backup-2026-10-21T00-00-00-000Z-0123456789abcdef/";
  const objects = new Map<string, Uint8Array>([
    [`${base}data.enc`, payload.encryptedData],
    [`${base}key.enc`, payload.encryptedKey],
    [`${base}iv.bin`, payload.iv],
    [
      `${base}manifest.json`,
      Buffer.from(
        JSON.stringify({
          version: "repo_backup_manifest/v1",
          workspacePath: "C:\\old-computer\\repo",
          createdAt: "2026-10-21T00:00:00.000Z",
          totalFiles: files.length,
          totalSize: files.reduce((sum, file) => sum + file.content.length, 0),
          entries: files.map((file) => ({
            path: file.path,
            size: file.content.length,
            sha256: createHash("sha256").update(file.content).digest("hex"),
          })),
        }),
      ),
    ],
  ]);
  const store: BackupObjectStore = {
    location: "oss",
    revision: "fixture",
    get: async (key) => objects.get(key) ?? null,
    list: async () => [...objects.keys()],
    put: async (key, data) => {
      objects.set(key, data);
    },
    remove: async (key) => {
      objects.delete(key);
    },
  };
  const crypto = createBackupCrypto(root, async () => pair);
  const legacy = createLegacyBackupRecovery(async () => store, crypto.openLegacy);
  const versions = await legacy.list("oss");
  assert.equal(versions.length, 1);
  assert.equal(versions[0]!.format, 1);
  const reference = {
    id: versions[0]!.id,
    location: "oss" as const,
    locationRevision: versions[0]!.locationRevision,
  };
  const snapshot = await legacy.read(reference);
  await createGitBackupSource().inspect(snapshot, {
    ...reference,
    mode: "merge",
    destinationPath: join(root, "restored"),
  });
  const damaged = Buffer.from(payload.encryptedData);
  damaged[damaged.length - 1]! ^= 1;
  objects.set(`${base}data.enc`, damaged);
  await assert.rejects(legacy.read(reference), /hash mismatch/);
  objects.set(`${base}data.enc`, payload.encryptedData);
  const remove = store.remove;
  let interrupted = false;
  store.remove = async (key) => {
    if (!interrupted && key.endsWith("data.enc")) {
      interrupted = true;
      throw new Error("fixture deletion interruption");
    }
    await remove(key);
  };
  await assert.rejects(legacy.remove(reference), /interruption/);
  assert.equal((await legacy.list("oss")).length, 0);
  await createLegacyBackupRecovery(async () => store, crypto.openLegacy).remove(reference);
  assert.equal((await legacy.list("oss")).length, 0);
  assert.ok([...objects.keys()].every((key) => key.endsWith("tombstone.deleted")));
});
