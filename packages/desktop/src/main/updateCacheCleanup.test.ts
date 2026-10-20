import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { cleanupInstalledUpdateCache } from "./updateCacheCleanup.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "lcode-update-cleanup-"));
  const directory = join(root, "updates");
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const add = async (name: string) => {
    await mkdir(join(directory, name), { recursive: true });
    await writeFile(join(directory, name, "package"), name);
  };
  return { root, directory, add };
}

test("三平台成功启动后清空已安装缓存，保留未来待安装版本并且幂等", async (t) => {
  for (const platform of ["mac", "win", "linux"]) {
    const f = await fixture(t);
    for (const version of ["3.18.7", "3.19.4", "3.19.9", "3.19.10"])
      await f.add(`${platform}-${version}`);
    await cleanupInstalledUpdateCache(f.directory, "3.19.9");
    assert.deepEqual(await readdir(f.directory), [`${platform}-3.19.10`]);
    await cleanupInstalledUpdateCache(f.directory, "3.19.10");
    assert.deepEqual(await readdir(f.directory), []);
    await cleanupInstalledUpdateCache(f.directory, "3.19.10");
  }
});

test("preview 按 semver 排序，不删除未知目录、普通文件和非法版本", async (t) => {
  const f = await fixture(t);
  for (const name of [
    "mac-3.20.0-preview.1",
    "mac-3.20.0-preview.2",
    "mac-3.20.0",
    "mac-invalid",
    "other-1.0.0",
  ])
    await f.add(name);
  await writeFile(join(f.directory, "win-1.0.0"), "ordinary file");
  await cleanupInstalledUpdateCache(f.directory, "3.20.0-preview.2");
  assert.deepEqual((await readdir(f.directory)).sort(), [
    "mac-3.20.0",
    "mac-invalid",
    "other-1.0.0",
    "win-1.0.0",
  ]);
  await cleanupInstalledUpdateCache(f.directory, "invalid");
  assert.equal((await readdir(f.directory)).length, 4);
});

test("缺失缓存和目录链接不扩大删除范围", async (t) => {
  const f = await fixture(t);
  await cleanupInstalledUpdateCache(f.directory, "3.19.9");
  const outside = join(f.root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "keep"), "preserved");
  await mkdir(f.directory);
  await symlink(
    outside,
    join(f.directory, "mac-1.0.0"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await cleanupInstalledUpdateCache(f.directory, "3.19.9");
  const rootLink = join(f.root, "linked-updates");
  await symlink(outside, rootLink, process.platform === "win32" ? "junction" : "dir");
  await cleanupInstalledUpdateCache(rootLink, "3.19.9");
  assert.equal(await readFile(join(outside, "keep"), "utf8"), "preserved");
  assert.deepEqual(await readdir(f.directory), ["mac-1.0.0"]);
});
