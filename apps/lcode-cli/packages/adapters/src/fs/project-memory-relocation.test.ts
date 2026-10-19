import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { NodeFileSystemAdapter } from "./index.js";
import { prepareMemoryRoot } from "./project-memory-paths.js";
import { digest, hasCode, seedPrepared } from "./project-memory.test-support.js";

async function portable(t: TestContext) {
  const base = await mkdtemp(join(await realpath(tmpdir()), "lcode-memory-relocation-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = join(base, "source", ".lcode", "memory");
  const destination = join(base, "destination", ".lcode", "memory");
  const adapter = new NodeFileSystemAdapter();
  await adapter.projectMemory!.registerRoot(source);
  await adapter.writeTextFile({
    path: join(source, "fact.md"),
    content: "portable fact",
    expectedMissing: true,
  });
  return {
    base,
    source,
    destination,
    adapter,
    state: join(base, "source", ".lcode", "memory-state"),
    copiedState: join(base, "destination", ".lcode", "memory-state"),
  };
}

test("relocated project retains old recovery state and gets one restart-safe local writer namespace", async (t) => {
  const f = await portable(t);
  const claim = await f.adapter.projectMemory!.learning!.claim({
    rootDir: f.source,
    workspaceKey: f.source,
    evidenceKey: digest("old turn"),
  });
  assert.equal(claim.status, "claimed");
  if (claim.status !== "claimed") return;
  await seedPrepared({
    rootDir: f.source,
    stateDir: f.state,
    id: "pending-old-transaction",
    fileName: "pending.md",
    before: null,
    after: "must not replay at a different root",
  });
  const owner = await readFile(join(f.state, "owner.json"), "utf8");
  const ledger = await readFile(join(f.state, "learning.json"), "utf8");
  await cp(join(f.base, "source", ".lcode"), join(f.base, "destination", ".lcode"), {
    recursive: true,
  });
  const next = new NodeFileSystemAdapter();
  const other = new NodeFileSystemAdapter();
  await Promise.all([
    next.projectMemory!.registerRoot(f.destination),
    other.projectMemory!.registerRoot(f.destination),
  ]);
  assert.equal(await readFile(join(f.destination, "fact.md"), "utf8"), "portable fact");
  await assert.rejects(readFile(join(f.destination, "pending.md")), { code: "ENOENT" });
  const root = await prepareMemoryRoot(f.destination);
  assert.ok(root.stateDir.includes(`${join("memory-state", "relocated")}`));
  assert.equal(await readFile(join(f.copiedState, "owner.json"), "utf8"), owner);
  assert.equal(await readFile(join(f.copiedState, "learning.json"), "utf8"), ledger);
  const input = {
    rootDir: f.destination,
    workspaceKey: f.destination,
    evidenceKey: digest("new turn"),
  };
  const claimed = await next.projectMemory!.learning!.claim(input);
  assert.equal(claimed.status, "claimed");
  if (claimed.status !== "claimed") return;
  await next.projectMemory!.learning!.finish({ rootDir: f.destination, lease: claimed.lease });
  assert.equal((await other.projectMemory!.learning!.claim(input)).status, "consumed");
  await assert.rejects(
    next.projectMemory!.learning!.finish({ rootDir: f.destination, lease: claim.lease }),
    hasCode("stale_write"),
  );
  for (const path of [join(f.copiedState, "owner.json"), join(root.stateDir, "owner.json")]) {
    await assert.rejects(next.writeTextFile({ path, content: "forged" }), hasCode("invalid_path"));
    await assert.rejects(next.removeFile({ path }), hasCode("invalid_path"));
  }
  await next.writeTextFile({
    path: join(f.destination, "new.md"),
    content: "new learned fact",
    expectedMissing: true,
  });
  assert.equal(await readFile(join(f.destination, "new.md"), "utf8"), "new learned fact");
  assert.equal(await readFile(join(f.state, "learning.json"), "utf8"), ledger);
});

test("different identity and profile layouts never adopt copied recovery owners", async (t) => {
  const f = await portable(t);
  const destination = join(
    f.base,
    "destination",
    ".lcode",
    "memories",
    "2222222222222222",
    "memory",
  );
  await cp(
    join(f.base, "source", ".lcode"),
    join(f.base, "destination", ".lcode", "memories", "2222222222222222"),
    { recursive: true },
  );
  await assert.rejects(
    new NodeFileSystemAdapter().projectMemory!.registerRoot(destination),
    hasCode("invalid_path"),
  );
  await cp(join(f.base, "source", ".lcode"), join(f.base, "destination-profile"), {
    recursive: true,
  });
  const profile = join(f.base, "destination-profile", "memory");
  await assert.rejects(
    new NodeFileSystemAdapter().projectMemory!.registerRoot(profile),
    hasCode("invalid_path"),
  );
});

test("relocation namespace capacity preserves existing memory and owners", async (t) => {
  const f = await portable(t);
  await cp(join(f.base, "source", ".lcode"), join(f.base, "destination", ".lcode"), {
    recursive: true,
  });
  const namespaces = join(f.copiedState, "relocated");
  await mkdir(namespaces);
  for (let i = 0; i < 16; i++) await mkdir(join(namespaces, i.toString(16).padStart(32, "0")));
  await assert.rejects(
    new NodeFileSystemAdapter().projectMemory!.registerRoot(f.destination),
    hasCode("too_large"),
  );
  assert.equal(await readFile(join(f.destination, "fact.md"), "utf8"), "portable fact");
  assert.equal(
    await readFile(join(f.copiedState, "owner.json"), "utf8"),
    await readFile(join(f.state, "owner.json"), "utf8"),
  );
});

test("relocation namespace junctions never route writes outside the project", async (t) => {
  const f = await portable(t);
  await cp(join(f.base, "source", ".lcode"), join(f.base, "destination", ".lcode"), {
    recursive: true,
  });
  const outside = join(f.base, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "unchanged");
  await symlink(
    outside,
    join(f.copiedState, "relocated"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    new NodeFileSystemAdapter().projectMemory!.registerRoot(f.destination),
    hasCode("invalid_path"),
  );
  assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "unchanged");
});
