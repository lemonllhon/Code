import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  createCuaHelperInstaller,
  resolveHelperPermissionSubjectIdentity,
} from "./broker-server.js";
import { HELPER_APP_NAME, HELPER_BUNDLE_ID } from "./broker-helper-constants.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cua install bundle "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "bundled", HELPER_APP_NAME);
  const installRoot = join(root, "installed");
  const target = join(installRoot, HELPER_APP_NAME);
  await mkdir(join(source, "Contents", "MacOS"), { recursive: true });
  await writeFile(join(source, "Contents", "MacOS", "helper"), "fixture");
  const build = (path, version) => writeFile(join(path, "Contents", "Info.plist"), version);
  await build(source, "1");
  const verified = [];
  let failCopy = false;
  let failFinal = false;
  const installer = createCuaHelperInstaller({
    platform: "darwin",
    arch: "x64",
    env: { LCODE_RUNTIME_ENV: "production" },
    bundledAppPath: source,
    installRoot,
    dependencies: {
      // 保留真实目录/后缀/越界校验，避免 mock 掩盖临时包不再是 .app 的安装缺陷。
      resolveIdentity: async (path) => {
        verified.push(path);
        if (failFinal && path === target) throw new Error("final verification rejected");
        return resolveHelperPermissionSubjectIdentity(path, {
          platform: "darwin",
          readPlistValue: async (plist, key) => {
            if (key === "CFBundleExecutable") return "helper";
            if (key === "CFBundleIdentifier") return HELPER_BUNDLE_ID;
            if (key === "CFBundleVersion") return readFile(plist, "utf8");
            return "Computer Use";
          },
        });
      },
      readExecutableArchs: async () => ["x86_64"],
      copyBundle: async (from, to) => {
        await cp(from, to, { recursive: true });
        if (failCopy) throw new Error("copy interrupted");
      },
    },
  });
  return {
    installer,
    source,
    target,
    installRoot,
    verified,
    build,
    failCopy: () => {
      failCopy = true;
    },
    failFinal: () => {
      failFinal = true;
    },
  };
}

test("real bundle identity accepts staged first install, reuse and upgrade", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.installer.ensureInstalled(), f.target);
  assert.ok(f.verified.every((path) => basename(path).endsWith(".app")));
  assert.deepEqual(await readdir(f.installRoot), [HELPER_APP_NAME]);
  const count = f.verified.length;
  assert.equal(await f.installer.ensureInstalled(), f.target);
  assert.equal(f.verified.length - count, 2);
  await f.build(f.source, "2");
  await f.installer.ensureInstalled();
  assert.equal(await readFile(join(f.target, "Contents", "Info.plist"), "utf8"), "2");
  assert.deepEqual(await readdir(f.installRoot), [HELPER_APP_NAME]);
});

test("failed final verification restores previous bundle and removes staging root", async (t) => {
  const f = await fixture(t);
  await f.installer.ensureInstalled();
  await f.build(f.source, "2");
  f.failFinal();
  await assert.rejects(f.installer.ensureInstalled(), /final verification rejected/);
  assert.equal(await readFile(join(f.target, "Contents", "Info.plist"), "utf8"), "1");
  assert.deepEqual(await readdir(f.installRoot), [HELPER_APP_NAME]);
});

test("interrupted copy removes its private staging root without creating an installed bundle", async (t) => {
  const f = await fixture(t);
  f.failCopy();
  await assert.rejects(f.installer.ensureInstalled(), /copy interrupted/);
  assert.deepEqual(await readdir(f.installRoot), []);
});
