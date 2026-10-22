import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createBackupEngine } from "./backupEngine.js";
import type { BackupEnginePorts, BackupEngineState, BackupObjectStore } from "./ports.js";
import type { BackupSnapshot } from "../contract.js";
function fixture() {
  let serial = 0;
  let content = "first";
  let clock = 1_000_000;
  let failures = false;
  let writes = 0;
  const objects = new Map<string, Uint8Array>();
  const state: BackupEngineState = {
    version: 1,
    sourceId: "ours",
    policy: {
      revision: 0,
      localEnabled: true,
      localDirectory: null,
      retention: { local: 2, oss: 2, minio: 2 },
      providers: {
        enabled: true,
        intervalMinutes: 5,
        selection: null,
        locations: ["local", "oss"],
      },
    },
    nextProviderAt: null,
    lastCheckAt: null,
    lastResult: null,
    error: null,
    checkpoints: {},
    operations: {},
  };
  const destination = (location: "local" | "oss"): BackupObjectStore => ({
    location,
    revision: location,
    async put(key, value) {
      if (location === "oss" && failures) throw new Error("offline");
      writes++;
      objects.set(`${location}/${key}`, value);
    },
    async get(key) {
      return objects.get(`${location}/${key}`) ?? null;
    },
    async remove(key) {
      objects.delete(`${location}/${key}`);
    },
    async list(prefix) {
      return [...objects.keys()]
        .filter((key) => key.startsWith(`${location}/${prefix}`))
        .map((key) => key.slice(location.length + 1));
    },
  });
  const capture = async (): Promise<BackupSnapshot> => ({
    kind: "providers",
    targetKey: "profile",
    label: "Providers",
    selection: null,
    items: [{ id: "p1", label: "P1", type: "provider" }],
    data: { key: content },
  });
  const ports: BackupEnginePorts = {
    now: () => clock,
    id: () => `id-${++serial}`,
    digest: (x) => createHash("sha256").update(x).digest("hex"),
    exclusive: (fn) => fn(),
    state: async (fn) => fn(state),
    sources: {
      providers: {
        capture,
        inspect: async () => ({ revision: content, changes: [], warnings: [] }),
        restore: async (_snapshot, _request, revision) => {
          assert.equal(revision, content);
          return { restored: 1, warnings: [] };
        },
      },
    },
    destinations: async () => [destination("local"), destination("oss")],
    destination: async (x) => destination(x as "local"),
    seal: async (value) => ({ bytes: Buffer.from(JSON.stringify(value)), keyId: "key" }),
    open: async (bytes) => JSON.parse(Buffer.from(bytes).toString()),
    exportKeys: async () => "kit",
    importKeys: async () => {},
    restorePlans: new Map(),
  };
  return {
    ports,
    engine: createBackupEngine(ports),
    state,
    objects,
    setContent(x: string) {
      content = x;
      clock++;
    },
    fail(x: boolean) {
      failures = x;
    },
    writes: () => writes,
  };
}
test("unchanged backups make no new writes and failed destination alone is retried", async () => {
  const f = fixture();
  f.fail(true);
  const first = await f.engine.service.backupNow({ kind: "providers", operationId: "op-1" });
  assert.deepEqual(
    first.results.map((x) => x.status),
    ["created", "failed"],
  );
  f.fail(false);
  const before = f.writes();
  const retry = await f.engine.service.backupNow({ kind: "providers", operationId: "op-2" });
  assert.deepEqual(
    retry.results.map((x) => x.status),
    ["skipped-unchanged", "created"],
  );
  assert.equal(f.writes() - before, 2);
  const complete = f.writes();
  await f.engine.service.backupNow({ kind: "providers", operationId: "op-3" });
  assert.equal(f.writes(), complete);
  await f.engine.service.backupNow({ kind: "providers", operationId: "op-1" });
  assert.equal(f.writes(), complete);
});
test("new computer discovers cloud catalog and retention only deletes old complete copies", async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) {
    f.setContent(String(i));
    await f.engine.service.backupNow({ kind: "providers", operationId: `op-${i}` });
  }
  assert.equal((await f.engine.service.listBackups("oss")).length, 2);
  assert.equal((await f.engine.service.listBackups("local")).length, 2);
  f.state.checkpoints = {};
  assert.equal((await f.engine.service.listBackups("oss")).length, 2);
});
test("restore preview retains authenticated snapshot, rejects stale source revision, and deletion is exact", async () => {
  const f = fixture();
  await f.engine.service.backupNow({ kind: "providers", operationId: "op" });
  const version = (await f.engine.service.listBackups("local"))[0]!;
  const preview = await f.engine.service.planBackupRestore({
    id: version.id,
    location: version.location,
    locationRevision: version.locationRevision,
    mode: "merge",
  });
  f.setContent("changed");
  await assert.rejects(
    f.engine.service.commitBackupRestore(preview.planId, "restore"),
    /changed|conflict/i,
  );
  await f.engine.service.deleteBackups(
    [{ id: version.id, location: "local", locationRevision: version.locationRevision }],
    "delete",
  );
  assert.equal((await f.engine.service.listBackups("local")).length, 0);
  assert.equal((await f.engine.service.listBackups("oss")).length, 1);
});
test("completed manifest repairs a lost checkpoint without another upload", async () => {
  const f = fixture();
  const originalState = f.ports.state;
  let armed = true;
  f.ports.state = async (operation) => {
    if (
      armed &&
      [...f.objects.keys()].some(
        (key) => key.startsWith("local/") && key.endsWith("/manifest.json"),
      ) &&
      !Object.keys(f.state.checkpoints).length
    ) {
      armed = false;
      throw new Error("fixture state write interrupted");
    }
    return originalState(operation);
  };
  await f.engine.service.backupNow({ kind: "providers", operationId: "interrupted" });
  const before = f.writes();
  await f.engine.service.backupNow({ kind: "providers", operationId: "recover" });
  assert.equal(f.writes(), before);
  assert.equal((await f.engine.service.listBackups("local")).length, 1);
});
test("offline packages import idempotently and can explicitly reimport a locally deleted version", async () => {
  const f = fixture();
  await f.engine.service.backupNow({ kind: "providers", operationId: "backup" });
  const version = (await f.engine.service.listBackups("local"))[0]!;
  const archive = await f.engine.service.exportBackupArchive({
    id: version.id,
    location: "local",
    locationRevision: version.locationRevision,
  });
  await f.engine.service.deleteBackups(
    [{ id: version.id, location: "local", locationRevision: version.locationRevision }],
    "delete",
  );
  await f.engine.service.importBackupArchive(archive, "import");
  assert.equal((await f.engine.service.listBackups("local")).length, 1);
  const writes = f.writes();
  await f.engine.service.importBackupArchive(archive, "import-again");
  assert.equal(f.writes(), writes);
});
test("interrupted deletion resumes from durable intent and never deletes a sibling copy", async () => {
  const f = fixture();
  await f.engine.service.backupNow({ kind: "providers", operationId: "backup" });
  const version = (await f.engine.service.listBackups("local"))[0]!;
  const original = f.ports.destination;
  let interrupt = true;
  f.ports.destination = async (location) => {
    const store = await original(location);
    return {
      ...store,
      async remove(key) {
        if (interrupt && key.endsWith("archive.json")) {
          interrupt = false;
          throw new Error("fixture delete interrupted");
        }
        await store.remove(key);
      },
    };
  };
  const result = await f.engine.service.deleteBackups(
    [{ id: version.id, location: "local", locationRevision: version.locationRevision }],
    "delete",
  );
  assert.equal(result.errors.length, 1);
  assert.equal(Object.keys(f.state.pendingDeletions ?? {}).length, 1);
  await createBackupEngine(f.ports).resumeDeletes();
  assert.equal(Object.keys(f.state.pendingDeletions ?? {}).length, 0);
  assert.equal((await f.engine.service.listBackups("local")).length, 0);
  assert.equal((await f.engine.service.listBackups("oss")).length, 1);
});
test("restore previews are bounded, expire and never admit a stale credential snapshot", async () => {
  const f = fixture();
  await f.engine.service.backupNow({ kind: "providers", operationId: "backup" });
  const version = (await f.engine.service.listBackups("local"))[0]!;
  const request = {
    id: version.id,
    location: "local" as const,
    locationRevision: version.locationRevision,
    mode: "merge" as const,
  };
  const first = await f.engine.service.planBackupRestore(request);
  for (let i = 0; i < 4; i++) await f.engine.service.planBackupRestore(request);
  assert.equal(f.ports.restorePlans.size, 4);
  await assert.rejects(f.engine.service.commitBackupRestore(first.planId, "evicted"), /expired/);
  const last = await f.engine.service.planBackupRestore(request);
  const now = f.ports.now();
  f.ports.now = () => now + 600_001;
  await assert.rejects(f.engine.service.commitBackupRestore(last.planId, "expired"), /expired/);
});

test("legacy deletion uses the same durable retry owner as v2", async () => {
  const f = fixture();
  let attempts = 0;
  f.ports.legacy = {
    list: async () => [],
    read: async () => {
      throw new Error("unused");
    },
    remove: async () => {
      if (++attempts === 1) throw new Error("interruption");
    },
  };
  const destination = await f.ports.destination("local");
  const ref = {
    id: `legacy-${"a".repeat(64)}`,
    location: "local" as const,
    locationRevision: f.ports.digest(destination.revision),
  };
  const result = await f.engine.service.deleteBackups([ref], "legacy-delete");
  assert.equal(result.errors.length, 1);
  assert.equal(Object.keys(f.state.pendingDeletions ?? {}).length, 1);
  await createBackupEngine(f.ports).resumeDeletes();
  assert.equal(attempts, 2);
  assert.equal(Object.keys(f.state.pendingDeletions ?? {}).length, 0);
});

test("location replacement invalidates preview, download and deletion without modifying copies", async () => {
  const f = fixture();
  await f.engine.service.backupNow({ kind: "providers", operationId: "backup" });
  const version = (await f.engine.service.listBackups("local"))[0]!;
  const reference = {
    id: version.id,
    location: "local" as const,
    locationRevision: version.locationRevision,
  };
  const preview = await f.engine.service.planBackupRestore({ ...reference, mode: "merge" });
  const original = f.ports.destination;
  f.ports.destination = async (location) => ({
    ...(await original(location)),
    revision: "replaced",
  });
  await assert.rejects(
    f.engine.service.commitBackupRestore(preview.planId, "restore"),
    /location changed/,
  );
  await assert.rejects(
    f.engine.service.planBackupRestore({ ...reference, mode: "merge" }),
    /location changed/,
  );
  await assert.rejects(f.engine.service.exportBackupArchive(reference), /location changed/);
  const deletion = await f.engine.service.deleteBackups([reference], "delete");
  assert.equal(deletion.errors.length, 1);
  assert.equal((await f.engine.service.listBackups("local")).length, 1);
});
