import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { join, resolve } from "node:path";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { publishFixture } from "./gitPublishTestHelpers.js";
import { coordinateGitCheckoutWrites } from "./gitCheckoutCoordination.js";
import { createGitService } from "./gitService.js";
import { createCheckoutCoordinator } from "../worktree/node.js";

async function fixture(t: TestContext, wrap?: Parameters<typeof publishFixture>[1]) {
  const f = await publishFixture(t, wrap);
  const coordinator = createCheckoutCoordinator({ dataDir: join(f.base, "coord"), git: f.command });
  const raw = createGitService({
    commandProvider: f.command,
    reviewStateDataDir: join(f.base, "receipts"),
    checkoutCoordinator: coordinator,
  });
  const service = coordinateGitCheckoutWrites(raw, coordinator);
  const scope = f.request;
  let serial = 0;
  const save = async (includeUntracked = false) =>
    service.saveStash({
      ...scope,
      requestId: `save-${++serial}`,
      expectedRevision: (await service.getStashSnapshot(scope)).revision,
      expectedState: await service.getPublishState(scope),
      includeUntracked,
      message: "fixture stash",
    });
  const select = async () => {
    const snapshot = await service.getStashSnapshot(scope);
    const entry = snapshot.entries[0]!;
    return {
      ...scope,
      oid: entry.oid,
      selector: entry.selector,
      expectedRevision: snapshot.revision,
    };
  };
  return { ...f, coordinator, raw, service, scope, save, select };
}

test("保存预览来自完整 status：空文件、重命名和子目录范围准确", async (t) => {
  const f = await fixture(t);
  await f.git("mv", "a.txt", "renamed.txt");
  await writeFile(join(f.root, "empty.txt"), "");
  const excluded = await f.service.previewStashSave({ ...f.scope, includeUntracked: false });
  assert.deepEqual(excluded.files, ["a.txt", "renamed.txt"]);
  const included = await f.service.previewStashSave({ ...f.scope, includeUntracked: true });
  assert.deepEqual(included.files, ["a.txt", "empty.txt", "renamed.txt"]);
  assert.equal(resolve(included.root), resolve(f.root));
  assert.equal((await f.service.getStashSnapshot(f.scope)).entries.length, 0);
});

test("精确删除与原生 reflog rewrite 字节一致，最后一条删除后为空", async (t) => {
  const f = await fixture(t);
  for (const content of ["一", "二", "三"]) {
    await writeFile(join(f.root, "a.txt"), content);
    await f.save();
  }
  const logPath = join(f.root, ".git", "logs", "refs", "stash"),
    refPath = join(f.root, ".git", "refs", "stash");
  const originalLog = await readFile(logPath),
    originalRef = await readFile(refPath);
  const snapshot = await f.service.getStashSnapshot(f.scope),
    entry = snapshot.entries[1]!;
  await f.git("stash", "drop", entry.selector);
  const expectedLog = await readFile(logPath),
    expectedRef = await readFile(refPath);
  await writeFile(logPath, originalLog);
  await writeFile(refPath, originalRef);
  assert.equal(
    (
      await f.service.dropStash({
        ...f.scope,
        oid: entry.oid,
        selector: entry.selector,
        expectedRevision: snapshot.revision,
        requestId: "middle",
      })
    ).status,
    "success",
  );
  assert.deepEqual(await readFile(logPath), expectedLog);
  assert.deepEqual(await readFile(refPath), expectedRef);
  for (const requestId of ["top", "last"])
    assert.equal(
      (await f.service.dropStash({ ...(await f.select()), requestId })).status,
      "success",
    );
  assert.equal((await f.service.getStashSnapshot(f.scope)).entries.length, 0);
  assert.equal(await f.git("status", "--porcelain"), "");
});

test("原生锁和 packed stash 引用拒绝删除，外部锁与原条目保留", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "a.txt"), "save\n");
  await f.save();
  const selected = await f.select(),
    lock = join(f.root, ".git", "refs", "stash.lock");
  await writeFile(lock, "external-owner");
  assert.equal(
    (await f.service.dropStash({ ...selected, requestId: "locked" })).code,
    "git-lock-busy",
  );
  assert.equal(await readFile(lock, "utf8"), "external-owner");
  await unlink(lock);
  await f.git("pack-refs", "--all");
  assert.equal(
    (await f.service.dropStash({ ...(await f.select()), requestId: "packed" })).code,
    "unsupported-stash-storage",
  );
  assert.equal((await f.service.getStashSnapshot(f.scope)).entries[0]!.oid, selected.oid);
});

test("原生保存已执行但结果超时：保留 reservation，重复请求只返回原收据", async (t) => {
  let calls = 0;
  const f = await fixture(t, (native) => ({
    ...native,
    run: async (params) => {
      const result = await native.run(params);
      if (params.args.includes("stash") && params.args.includes("push")) {
        calls++;
        return { ...result, timedOut: true };
      }
      return result;
    },
  }));
  await writeFile(join(f.root, "a.txt"), "saved\n");
  const params = {
    ...f.scope,
    requestId: "unknown",
    expectedRevision: (await f.service.getStashSnapshot(f.scope)).revision,
    expectedState: await f.state(),
    includeUntracked: false,
    message: "not persisted",
  };
  const result = await f.service.saveStash(params);
  assert.equal(result.status, "unknown");
  assert.ok(result.stashOid);
  assert.deepEqual(await f.service.saveStash(params), result);
  assert.equal(calls, 1);
  assert.equal((await f.service.getStashSnapshot(f.scope)).blocked, true);
  await assert.rejects(
    f.service.previewGitOperationCompletion({
      workspacePath: f.root,
      workspaceIdentity: "different",
      requestId: "unknown",
    }),
    /missing-operation/,
  );
  await assert.rejects(f.service.saveStash({ ...params, requestId: "new-request" }), {
    code: "LCODE_CHECKOUT_RESERVED",
  });
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "one\n");
});

test("无改动、隐藏修改、dirty apply 与注入字段均拒绝写入", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.save()).code, "no-changes");
  await f.git("update-index", "--assume-unchanged", "a.txt");
  await writeFile(join(f.root, "a.txt"), "hidden\n");
  assert.equal((await f.save()).code, "unsupported-checkout");
  await f.git("update-index", "--no-assume-unchanged", "a.txt");
  await f.save();
  const frozen = await f.state();
  await writeFile(join(f.root, "b.txt"), "dirty\n");
  const selected = await f.select();
  assert.equal(
    (
      await f.service.applyStash({
        ...f.scope,
        oid: selected.oid,
        expectedRevision: selected.expectedRevision,
        requestId: "stale-files",
        restoreIndex: false,
        expectedState: frozen,
      })
    ).code,
    "stale-preview",
  );
  assert.equal(
    (
      await f.service.applyStash({
        ...f.scope,
        oid: selected.oid,
        expectedRevision: selected.expectedRevision,
        requestId: "dirty",
        restoreIndex: false,
        expectedState: await f.state(),
      })
    ).code,
    "dirty-checkout",
  );
  await assert.rejects(
    f.service.dropStash({
      ...selected,
      requestId: "inject",
      allowReservationKey: "a".repeat(64),
    } as never),
  );
});

test("unborn 分支拒绝保存 Stash，保留现有未跟踪文件", async (t) => {
  const f = await fixture(t),
    root = join(f.base, "unborn");
  await mkdir(root);
  await f.at(root, "init", "-q", "-b", "main");
  await writeFile(join(root, "new.txt"), "keep\n");
  const scope = { workspacePath: root };
  const result = await f.service.saveStash({
    ...scope,
    requestId: "unborn",
    expectedRevision: (await f.service.getStashSnapshot(scope)).revision,
    expectedState: await f.service.getPublishState(scope),
    includeUntracked: true,
    message: "",
  });
  assert.equal(result.code, "unborn");
  assert.equal(await readFile(join(root, "new.txt"), "utf8"), "keep\n");
  assert.equal((await f.service.getStashSnapshot(scope)).entries.length, 0);
});

test("Stash 保存 staged/unstaged，默认保留 untracked/ignored，包含未跟踪需显式选择", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "a.txt"), "staged\n");
  await f.git("add", "a.txt");
  await writeFile(join(f.root, "a.txt"), "working\n");
  await writeFile(join(f.root, "new.txt"), "untracked\n");
  await writeFile(join(f.root, ".git", "info", "exclude"), "private.txt\n");
  await writeFile(join(f.root, "private.txt"), "private\n");
  const saved = await f.save();
  assert.equal(saved.status, "success");
  assert.ok(saved.stashOid);
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "one\n");
  assert.equal(await readFile(join(f.root, "new.txt"), "utf8"), "untracked\n");
  assert.equal(await readFile(join(f.root, "private.txt"), "utf8"), "private\n");
  const second = await f.save(true);
  assert.equal(second.status, "success");
  await assert.rejects(readFile(join(f.root, "new.txt")), { code: "ENOENT" });
  assert.equal(await readFile(join(f.root, "private.txt"), "utf8"), "private\n");
});

test("预览区分 index/worktree/untracked，apply --index 精确恢复且保留 stash", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "a.txt"), "staged\n");
  await f.git("add", "a.txt");
  await writeFile(join(f.root, "a.txt"), "working\n");
  await writeFile(join(f.root, "new.txt"), "untracked\n");
  await f.save(true);
  const selected = await f.select();
  const preview = await f.service.previewStash({
    ...f.scope,
    oid: selected.oid,
    expectedRevision: selected.expectedRevision,
  });
  assert.match(preview.sections.find((item) => item.source === "staged")!.patch, /staged/);
  assert.match(preview.sections.find((item) => item.source === "unstaged")!.patch, /working/);
  assert.match(preview.sections.find((item) => item.source === "untracked")!.patch, /untracked/);
  const params = {
    ...f.scope,
    oid: selected.oid,
    expectedRevision: selected.expectedRevision,
    requestId: "apply",
    expectedState: await f.state(),
    restoreIndex: true,
  };
  const applied = await f.service.applyStash(params);
  assert.equal(applied.status, "success");
  assert.match(await f.git("show", ":a.txt"), /staged/);
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "working\n");
  assert.equal((await f.service.getStashSnapshot(f.scope)).entries.length, 1);
  assert.deepEqual(await f.service.applyStash(params), applied);
});

test("stash reflog 变化拒绝旧预览，drop 只删除精确选中 OID", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "a.txt"), "first\n");
  await f.save();
  const first = await f.select();
  await writeFile(join(f.root, "a.txt"), "second\n");
  await f.save();
  assert.equal(
    (await f.service.dropStash({ ...first, requestId: "stale-drop" })).code,
    "stale-preview",
  );
  const snapshot = await f.service.getStashSnapshot(f.scope);
  const older = snapshot.entries[1]!;
  assert.equal(
    (
      await f.service.dropStash({
        ...f.scope,
        requestId: "drop-older",
        oid: older.oid,
        selector: older.selector,
        expectedRevision: snapshot.revision,
      })
    ).status,
    "success",
  );
  assert.deepEqual(
    (await f.service.getStashSnapshot(f.scope)).entries.map((item) => item.oid),
    [snapshot.entries[0]!.oid],
  );
});

test("真实 apply 冲突持久保留 stages/stash，重启拒绝 Agent，外部解决后确认恢复", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "a.txt"), "stash-side\n");
  await f.save();
  await writeFile(join(f.root, "a.txt"), "head-side\n");
  await f.git("commit", "-qam", "head-side");
  const selected = await f.select();
  const result = await f.service.applyStash({
    ...f.scope,
    requestId: "conflict",
    oid: selected.oid,
    expectedRevision: selected.expectedRevision,
    expectedState: await f.state(),
    restoreIndex: false,
  });
  assert.equal(result.status, "conflict");
  assert.equal(result.conflicts?.[0]?.path, "a.txt");
  assert.equal(result.conflicts?.[0]?.stages.length, 3);
  assert.equal((await f.service.getStashSnapshot(f.scope)).entries[0]?.oid, selected.oid);
  const restarted = createCheckoutCoordinator({ dataDir: join(f.base, "coord"), git: f.command });
  await assert.rejects(
    restarted.acquire({ ...f.scope, ownerId: "agent", mode: "shared", waitMs: 0 }),
    { code: "LCODE_CHECKOUT_RESERVED" },
  );
  const before = await f.service.previewGitOperationCompletion({
    ...f.scope,
    requestId: "conflict",
  });
  assert.equal(before.canComplete, false);
  await writeFile(join(f.root, "a.txt"), "resolved\n");
  await f.git("add", "a.txt");
  const preview = await f.service.previewGitOperationCompletion({
    ...f.scope,
    requestId: "conflict",
  });
  assert.equal(preview.canComplete, true);
  assert.equal(
    (
      await f.service.completeGitOperation({
        ...f.scope,
        requestId: "finish",
        sourceRequestId: "conflict",
        expectedRevision: preview.revision,
        confirmNativeStopped: false,
      })
    ).status,
    "success",
  );
  const lease = await restarted.acquire({
    ...f.scope,
    ownerId: "agent",
    mode: "shared",
    waitMs: 0,
  });
  await restarted.release(lease);
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "resolved\n");
});

test("dirty 或忽略文件碰撞拒绝 apply，原 stash 与文件都保留", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "new.txt"), "stash\n");
  await f.save(true);
  const selected = await f.select();
  await writeFile(join(f.root, ".git", "info", "exclude"), "new.txt\n");
  await writeFile(join(f.root, "new.txt"), "private\n");
  const result = await f.service.applyStash({
    ...f.scope,
    oid: selected.oid,
    expectedRevision: selected.expectedRevision,
    requestId: "ignored",
    expectedState: await f.state(),
    restoreIndex: false,
  });
  assert.equal(result.status, "failed");
  assert.equal(await readFile(join(f.root, "new.txt"), "utf8"), "private\n");
  assert.equal((await f.service.getStashSnapshot(f.scope)).entries.length, 1);
});
