import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { copyDataDirectory } from "../paths.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "lcode-data-migration-"));
  const databases: DatabaseSync[] = [];
  const source = join(root, "source");
  const target = join(root, "target");
  const put = async (path: string, content: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  };
  const sourcePath = (...segments: string[]) => join(source, ".lcode", ...segments);
  const targetPath = (...segments: string[]) => join(target, ".lcode", ...segments);
  t.after(async () => {
    for (const database of databases) database.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, source, target, put, sourcePath, targetPath, databases };
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

test("migration carries the whole data root and keeps only bootstrap settings at the original location", async (t) => {
  const f = await fixture(t);
  const files = [
    "v2/sessions/workspace/task.json",
    "v2/session-bindings/task.json",
    "v2/checkpoints/task/checkpoint.json",
    "cli/artifacts/session/attachment.bin",
    "cli/artifacts/session/setting.json",
    "cli/artifacts/session/setting.json.extra",
    "cli/artifacts/session/report.db",
    "cli/agents/session/agent/transcript.jsonl",
    "cli/memories/projects/project/memory/MEMORY.md",
    "cli/config.json",
    "cli/plugins/cache/plugin/manifest.json",
    "workspace/default/main.ts",
    "clipboard/image.png",
    "git-checkpoint-index/index.json",
    "unknown-future-data/record.json",
  ];
  for (const path of files) await f.put(f.sourcePath(path), `fixture:${path}`);
  for (const name of [
    "setting.json",
    "setting.json.lock",
    "setting.json.tmp",
    "setting.json.backup",
  ])
    await f.put(f.sourcePath("v2", name), "bootstrap-only");

  await copyDataDirectory(f.source, f.target);

  for (const path of files) {
    assert.equal(await readFile(f.targetPath(path), "utf8"), `fixture:${path}`, path);
    assert.equal(await readFile(f.sourcePath(path), "utf8"), `fixture:${path}`);
  }
  assert.deepEqual((await readdir(f.targetPath("v2"))).sort(), [
    "checkpoints",
    "session-bindings",
    "sessions",
  ]);
  assert.equal(await readFile(f.sourcePath("v2", "setting.json"), "utf8"), "bootstrap-only");
});

test("live SQLite backups include committed WAL messages and task rows without copying sidecars", async (t) => {
  const f = await fixture(t);
  const paths = ["cli/db/db.sqlite", "v2/tasks-index.sqlite", "custom/history.sqlite3"];
  for (const path of paths) {
    await mkdir(dirname(f.sourcePath(path)), { recursive: true });
    const writer = new DatabaseSync(f.sourcePath(path));
    f.databases.push(writer);
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    writer.exec(
      "CREATE TABLE session(id TEXT PRIMARY KEY); CREATE TABLE message(sessionId TEXT, content TEXT, artifactKey TEXT);",
    );
    writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    writer.prepare("INSERT INTO session VALUES (?)").run("sess_fixture");
    writer
      .prepare("INSERT INTO message VALUES (?, ?, ?)")
      .run("sess_fixture", "persisted in WAL", "attachment.txt");
    assert.ok((await stat(`${f.sourcePath(path)}-wal`)).size > 0);
  }
  await f.put(f.sourcePath("cli/artifacts/sess_fixture/attachment.txt"), "referenced artifact");

  await copyDataDirectory(f.source, f.target);

  for (const path of paths) {
    for (const suffix of ["-wal", "-shm", "-journal"])
      assert.equal(await exists(`${f.targetPath(path)}${suffix}`), false, `${path}${suffix}`);
    const reader = new DatabaseSync(f.targetPath(path));
    try {
      assert.equal(reader.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
      assert.equal(reader.prepare("SELECT id FROM session").get()?.id, "sess_fixture");
      assert.equal(
        reader.prepare("SELECT content FROM message").get()?.content,
        "persisted in WAL",
      );
      assert.equal(
        reader.prepare("SELECT artifactKey FROM message").get()?.artifactKey,
        "attachment.txt",
      );
    } finally {
      reader.close();
    }
  }
  assert.equal(
    await readFile(f.targetPath("cli/artifacts/sess_fixture/attachment.txt"), "utf8"),
    "referenced artifact",
  );
});

test("a CLI-only profile does not require a v2 directory", async (t) => {
  const f = await fixture(t);
  await f.put(f.sourcePath("cli/artifacts/session/output.txt"), "output");
  await copyDataDirectory(f.source, f.target);
  assert.equal(await readFile(f.targetPath("cli/artifacts/session/output.txt"), "utf8"), "output");
});

test("existing target data is rejected without silently merging or overwriting either side", async (t) => {
  const f = await fixture(t);
  await f.put(f.sourcePath("v2/task.json"), "source task");
  await f.put(f.targetPath("v2/task.json"), "target task");
  await assert.rejects(copyDataDirectory(f.source, f.target), /target|exist/i);
  assert.equal(await readFile(f.sourcePath("v2/task.json"), "utf8"), "source task");
  assert.equal(await readFile(f.targetPath("v2/task.json"), "utf8"), "target task");
});

test("same normalized root is a no-op and overlapping data roots are rejected", async (t) => {
  const f = await fixture(t);
  await f.put(f.sourcePath("v2/task.json"), "task");
  await copyDataDirectory(f.source, join(f.source, "."));
  await assert.rejects(
    copyDataDirectory(f.source, f.sourcePath("nested")),
    /overlap|inside|nested/i,
  );
  assert.equal(await readFile(f.sourcePath("v2/task.json"), "utf8"), "task");
  assert.equal(await exists(f.sourcePath("nested", ".lcode")), false);
  const nestedBase = f.sourcePath("nested-profile");
  await mkdir(join(nestedBase, ".lcode"), { recursive: true });
  await assert.rejects(copyDataDirectory(nestedBase, f.source), /overlap/i);
});

test("directory links are not copied and linked aliases cannot bypass overlap checks", async (t) => {
  const f = await fixture(t);
  const external = join(f.root, "external");
  await f.put(join(external, "outside.txt"), "external");
  await f.put(f.sourcePath("v2/task.json"), "task");
  await symlink(
    external,
    f.sourcePath("external-link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const alias = join(f.root, "source-alias");
  await symlink(f.source, alias, process.platform === "win32" ? "junction" : "dir");
  await copyDataDirectory(f.source, alias);
  await assert.rejects(
    copyDataDirectory(f.source, join(alias, ".lcode", "nested")),
    /overlap|inside|nested/i,
  );
  await copyDataDirectory(f.source, f.target);
  assert.equal(await exists(f.targetPath("external-link")), false);
  assert.equal(await readFile(join(external, "outside.txt"), "utf8"), "external");
});

test("an invalid required session database never publishes a partial destination and retry succeeds", async (t) => {
  const f = await fixture(t);
  await f.put(f.sourcePath("v2/task.json"), "task");
  const taskDatabase = new DatabaseSync(f.sourcePath("v2/tasks-index.sqlite"));
  taskDatabase.exec("CREATE TABLE task(id TEXT)");
  taskDatabase.close();
  await f.put(f.sourcePath("cli/db/db.sqlite"), "corrupted-database");
  await assert.rejects(copyDataDirectory(f.source, f.target));
  assert.equal(await exists(f.targetPath()), false);
  assert.deepEqual(await readdir(f.target), []);
  assert.equal(await readFile(f.sourcePath("cli/db/db.sqlite"), "utf8"), "corrupted-database");
  await rm(f.sourcePath("cli/db/db.sqlite"));
  const database = new DatabaseSync(f.sourcePath("cli/db/db.sqlite"));
  database.exec("CREATE TABLE session(id TEXT); INSERT INTO session VALUES ('sess_fixture')");
  database.close();
  await copyDataDirectory(f.source, f.target);
  assert.equal(await exists(f.targetPath("cli/db/db.sqlite")), true);
});
