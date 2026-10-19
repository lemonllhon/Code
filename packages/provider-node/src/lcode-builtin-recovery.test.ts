import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { withFileLock } from "@lcode/shared/node";
import { NodeLCodeBuiltinProviderConfigSource } from "./lcode-builtin-provider-config-source.js";
import { decodeLCodeBuiltinRelease } from "./lcode-builtin-release.js";
import { EndpointScopedLCodeBuiltinSource } from "./endpoint-scoped-lcode-builtin-source.js";

async function fixture(t: { after(fn: () => Promise<void> | void): void }) {
  const root = await mkdtemp(join(tmpdir(), "lcode-builtin-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundledFilePath = join(root, "runtime", "bundled", "lcode-builtin.json");
  const activeFilePath = join(root, "runtime", "endpoint-fixture", "lcode-builtin.json");
  await mkdir(dirname(bundledFilePath), { recursive: true });
  const raw = await readFile(
    new URL("../../../config/provider/lcode-builtin.json", import.meta.url),
    "utf8",
  );
  await writeFile(bundledFilePath, raw);
  const events: unknown[] = [];
  const source = new NodeLCodeBuiltinProviderConfigSource({
    bundledFilePath,
    activeFilePath,
    watch: false,
    onRecovery: (event) => events.push(event),
  });
  t.after(() => source.dispose());
  return { root, bundledFilePath, activeFilePath, source, raw, events };
}

test("运行期 Bundled 与 Active 副本丢失后从已验证随包基线恢复", async (t) => {
  const { source, bundledFilePath, activeFilePath, events } = await fixture(t);
  const before = await source.read();
  await rm(bundledFilePath);
  await rm(activeFilePath);
  const after = await source.read();
  assert.equal(after.revision, before.revision);
  assert.ok(JSON.parse(await readFile(bundledFilePath, "utf8")));
  assert.ok(JSON.parse(await readFile(activeFilePath, "utf8")));
  assert.equal(events.length, 1);
});

test("整个 runtime 目录删除可恢复，并发读取不丢失基线", async (t) => {
  const { source, root } = await fixture(t);
  const before = await source.read();
  await rm(join(root, "runtime"), { recursive: true });
  const after = await Promise.all(Array.from({ length: 6 }, () => source.read()));
  assert.ok(after.every((snapshot) => snapshot.revision === before.revision));
});

test("恢复损坏 Bundled 时保留有效 Active 的更高 revision", async (t) => {
  const { source, bundledFilePath, activeFilePath, raw } = await fixture(t);
  await source.read();
  const newer = JSON.parse(raw);
  newer.revision += 1;
  await source.applyRemoteRelease(decodeLCodeBuiltinRelease(newer));
  await writeFile(bundledFilePath, '{"token":"fixture-secret",broken');
  const snapshot = await source.read();
  assert.ok(snapshot.revision.startsWith(`lcode-builtin:${newer.revision}:`));
  assert.equal(JSON.parse(await readFile(activeFilePath, "utf8")).revision, newer.revision);
  assert.equal(
    JSON.parse(await readFile(bundledFilePath, "utf8")).revision,
    JSON.parse(raw).revision,
  );
});

test("冷启动没有可信基线时明确报告两份缺失，不制造空配置", async (t) => {
  const { source, bundledFilePath } = await fixture(t);
  await rm(bundledFilePath);
  await assert.rejects(source.read(), (error: unknown) => {
    const diagnostic = error as { code: string; availability: unknown };
    assert.equal(diagnostic.code, "LCODE_BUILTIN_CONFIG_UNAVAILABLE");
    assert.deepEqual(diagnostic.availability, { bundled: "missing", active: "missing" });
    return true;
  });
});

test("冷启动损坏配置诊断不含原始 JSON、路径或 token", async (t) => {
  const { source, bundledFilePath, root } = await fixture(t);
  await writeFile(bundledFilePath, '{"token":"fixture-secret",broken');
  await assert.rejects(source.read(), (error: unknown) => {
    const diagnostic = error as Error & { code: string; availability: unknown };
    assert.equal(diagnostic.code, "LCODE_BUILTIN_CONFIG_UNAVAILABLE");
    assert.deepEqual(diagnostic.availability, { bundled: "invalid", active: "missing" });
    assert.ok(!diagnostic.message.includes(root));
    assert.ok(!diagnostic.message.includes("fixture-secret"));
    return true;
  });
});

test("回收后不恢复或复活 Source", async (t) => {
  const { source, bundledFilePath } = await fixture(t);
  await source.read();
  source.dispose();
  await rm(bundledFilePath);
  await assert.rejects(source.read(), /dispose/);
  await assert.rejects(readFile(bundledFilePath), { code: "ENOENT" });
});

test("Bundled 目录不可写时以内存可信基线读取，不重复输出恢复告警", async (t) => {
  const { source, bundledFilePath, events } = await fixture(t);
  const before = await source.read();
  await rm(dirname(bundledFilePath), { recursive: true });
  await writeFile(dirname(bundledFilePath), "fixture-blocked-directory");
  assert.equal((await source.read()).revision, before.revision);
  assert.equal((await source.read()).revision, before.revision);
  assert.equal(events.length, 1);
  assert.equal((events[0] as { recovered: string }).recovered, "memory");
  assert.equal(await readFile(dirname(bundledFilePath), "utf8"), "fixture-blocked-directory");
});

test("Endpoint 切换只复用随包基线，不借用上一 Endpoint 的较新 Active", async (t) => {
  const { root, bundledFilePath, raw } = await fixture(t);
  let origin = "https://first.example.invalid";
  const source = new EndpointScopedLCodeBuiltinSource({
    bundledFilePath,
    environmentConfigRoot: root,
    platform: "linux-x86_64",
    appVersion: "3.19.5",
    watch: false,
    resolveEndpointOrigin: () => origin,
    fetchRelease: async () => null,
  });
  t.after(() => source.dispose());
  const first = await source.read();
  const firstActive = await source.resolveActiveFilePath();
  const newer = JSON.parse(raw);
  newer.revision += 10;
  await writeFile(firstActive, JSON.stringify(newer));
  await rm(bundledFilePath);
  origin = "https://second.example.invalid";
  const second = await source.read();
  assert.equal(second.revision.split(":")[1], first.revision.split(":")[1]);
  assert.notEqual(second.revision, first.revision);
  assert.equal(JSON.parse(await readFile(firstActive, "utf8")).revision, newer.revision);
});

test("watch 权限失败且 Bundled 缺失时仍读取有效的较新 Active", async (t) => {
  const { source, bundledFilePath, activeFilePath, raw } = await fixture(t);
  await source.read();
  const newer = JSON.parse(raw);
  newer.revision += 1;
  const active = JSON.stringify(newer);
  await writeFile(activeFilePath, active);
  await rm(bundledFilePath);
  const denied = t.mock.method(fs, "watch", () => {
    throw Object.assign(new Error("fixture-private-path"), { code: "EACCES" });
  });
  syncBuiltinESMExports();
  const reader = new NodeLCodeBuiltinProviderConfigSource({ bundledFilePath, activeFilePath });
  try {
    assert.ok((await reader.read()).revision.startsWith(`lcode-builtin:${newer.revision}:`));
    assert.equal(await readFile(activeFilePath, "utf8"), active);
  } finally {
    reader.dispose();
    denied.mock.restore();
    syncBuiltinESMExports();
  }
});

test("等待 Active 锁期间 dispose 不得迟到恢复 Bundled", async (t) => {
  const { source, bundledFilePath, activeFilePath } = await fixture(t);
  await source.read();
  await rm(bundledFilePath);
  let reading: Promise<unknown> | undefined;
  await withFileLock(activeFilePath, async () => {
    reading = source.read();
    await new Promise<void>((resolve) => setImmediate(resolve));
    source.dispose();
  });
  await assert.rejects(reading!, /dispose/);
  await assert.rejects(readFile(bundledFilePath), { code: "ENOENT" });
});

test("Bundled 与 Active 同路径时恢复复用同一把锁", { timeout: 5_000 }, async (t) => {
  const { bundledFilePath } = await fixture(t);
  const source = new NodeLCodeBuiltinProviderConfigSource({ bundledFilePath, watch: false });
  t.after(() => source.dispose());
  const before = await source.read();
  await rm(bundledFilePath);
  assert.equal((await source.read()).revision, before.revision);
});
