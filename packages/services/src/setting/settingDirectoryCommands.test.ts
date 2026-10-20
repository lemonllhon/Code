import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { getDataBaseDir, setDataBaseDir } from "../paths.js";
import { settingDirectoryCommands } from "./settingDirectoryCommands.js";
import { createSettingService } from "./settingService.js";

async function fixture(t: TestContext) {
  t.mock.method(console, "log", () => {});
  const root = await mkdtemp(join(tmpdir(), "lcode-setting-migration-"));
  const source = join(root, "source");
  const target = join(root, "target");
  const previousRoot = getDataBaseDir();
  const previousHome = process.env.LCODE_DESKTOP_HOME_DIR;
  process.env.LCODE_DESKTOP_HOME_DIR = source;
  setDataBaseDir(source);
  t.after(async () => {
    setDataBaseDir(previousRoot);
    if (previousHome === undefined) delete process.env.LCODE_DESKTOP_HOME_DIR;
    else process.env.LCODE_DESKTOP_HOME_DIR = previousHome;
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, source, target };
}

test("the settings owner persists the new root only after real session data and attachments migrate", async (t) => {
  const f = await fixture(t);
  const service = createSettingService();
  await service.update({ memoryEnabled: false });
  const sourceDb = join(f.source, ".lcode", "cli", "db", "db.sqlite");
  await mkdir(dirname(sourceDb), { recursive: true });
  const db = new DatabaseSync(sourceDb);
  db.exec("CREATE TABLE session(id TEXT); INSERT INTO session VALUES ('sess_fixture')");
  db.close();
  const artifact = join(".lcode", "cli", "artifacts", "sess_fixture", "file.txt");
  await mkdir(dirname(join(f.source, artifact)), { recursive: true });
  await writeFile(join(f.source, artifact), "attachment");

  await service.updateDataBaseDir(f.target);

  assert.equal((await createSettingService().get()).dataBaseDir, f.target);
  assert.equal(
    getDataBaseDir(),
    f.source,
    "current runtime remains on its captured root until restart",
  );
  assert.equal(await readFile(join(f.target, artifact), "utf8"), "attachment");
  const migrated = new DatabaseSync(join(f.target, ".lcode", "cli", "db", "db.sqlite"));
  try {
    assert.equal(migrated.prepare("SELECT id FROM session").get()?.id, "sess_fixture");
  } finally {
    migrated.close();
  }
  await assert.rejects(access(join(f.target, ".lcode", "v2", "setting.json")));
  const settings = JSON.parse(
    await readFile(join(f.source, ".lcode", "v2", "setting.json"), "utf8"),
  );
  assert.equal(settings.dataBaseDir, f.target);
  assert.equal(settings.memoryEnabled, false);
});

test("a failed database backup leaves the old setting intact and removes the migration staging root", async (t) => {
  const f = await fixture(t);
  const service = createSettingService();
  await service.update({ dataBaseDir: f.source });
  const database = join(f.source, ".lcode", "cli", "db", "db.sqlite");
  await mkdir(dirname(database), { recursive: true });
  await writeFile(database, "invalid database");
  await assert.rejects(service.updateDataBaseDir(f.target));
  assert.equal((await service.get()).dataBaseDir, f.source);
  assert.equal(getDataBaseDir(), f.source);
  assert.deepEqual(await readdir(f.target), []);
});

test("directory admission covers settings commit, rejects concurrent changes, and releases after completion", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.source, ".lcode", "v2"), { recursive: true });
  let releaseCommit!: () => void;
  let enteredCommit!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredCommit = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseCommit = resolve;
  });
  const commits: unknown[] = [];
  const commands = settingDirectoryCommands(async (patch) => {
    commits.push(patch);
    enteredCommit();
    await blocked;
  });
  const first = commands.updateDataBaseDir(f.target);
  try {
    await entered;
    await assert.rejects(commands.updateDataBaseDir(join(f.root, "concurrent")), /progress|busy/i);
    assert.equal(commits.length, 1);
  } finally {
    releaseCommit();
    await first;
  }
  await commands.updateDataBaseDir(join(f.root, "later"));
  assert.equal(commits.length, 2);
});

test("a settings commit failure preserves the completed copy and releases admission for another target", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.source, ".lcode", "cli", "artifacts"), { recursive: true });
  await writeFile(join(f.source, ".lcode", "cli", "artifacts", "file.txt"), "artifact");
  let failCommit = true;
  const commands = settingDirectoryCommands(async () => {
    if (failCommit) throw new Error("settings commit failed");
  });
  await assert.rejects(commands.updateDataBaseDir(f.target), /settings commit failed/);
  assert.equal(getDataBaseDir(), f.source);
  assert.equal(
    await readFile(join(f.target, ".lcode", "cli", "artifacts", "file.txt"), "utf8"),
    "artifact",
  );
  assert.deepEqual(await readdir(f.target), [".lcode"]);
  failCommit = false;
  await commands.updateDataBaseDir(join(f.root, "retry"));
});
