import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { join } from "node:path";
import { mkdir, readFile, symlink, writeFile, rmdir, lstat } from "node:fs/promises";
import { publishFixture } from "./gitPublishTestHelpers.js";
import { createGitService } from "./gitService.js";
import { coordinateGitCheckoutWrites } from "./gitCheckoutCoordination.js";
import { createCheckoutCoordinator } from "../worktree/node.js";
import type { GitAcquisitionOptions } from "@lcode/shared";

async function fixture(t: TestContext) {
  const f = await publishFixture(t);
  const coordinator = createCheckoutCoordinator({ dataDir: join(f.base, "coord"), git: f.command });
  const options = {
    commandProvider: f.command,
    reviewStateDataDir: join(f.base, "receipts"),
    checkoutCoordinator: coordinator,
  };
  const service = coordinateGitCheckoutWrites(createGitService(options), coordinator);
  const directory = join(f.base, "import");
  await mkdir(directory);
  const acquire = async (settings: GitAcquisitionOptions, id = "acquire") =>
    service.acquireRepository({
      options: settings,
      requestId: id,
      preview: await service.previewRepositoryAcquisition(settings),
    });
  return { ...f, coordinator, service, directory, acquire, options };
}

test("init 保留原文件、显式 main、同请求重放读取收据", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, "keep.txt"), "keep\n");
  const options = { workspacePath: f.directory, mode: "init" as const };
  const params = {
    options,
    requestId: "init",
    preview: await f.service.previewRepositoryAcquisition(options),
  };
  const result = await f.service.acquireRepository(params);
  assert.equal(result.status, "success");
  assert.equal(result.after, null);
  assert.equal((await f.at(f.directory, "branch", "--show-current")).trim(), "main");
  assert.equal(await readFile(join(f.directory, "keep.txt"), "utf8"), "keep\n");
  assert.deepEqual(await f.service.acquireRepository(params), result);
  await assert.rejects(f.service.previewRepositoryAcquisition(options), /already-repository/);
});

test("clone 仅创建新目标；重复/重启不重复克隆，原目录保持", async (t) => {
  const f = await fixture(t);
  const remote = await f.remote("origin");
  await f.git("push", "-q", "origin", "main");
  await remote.git("symbolic-ref", "HEAD", "refs/heads/main");
  const options = {
    workspacePath: f.directory,
    mode: "clone" as const,
    targetName: "cloned",
    url: remote.path,
  };
  const params = {
    options,
    requestId: "clone",
    preview: await f.service.previewRepositoryAcquisition(options),
  };
  const result = await f.service.acquireRepository(params);
  assert.equal(result.status, "success");
  assert.equal(await readFile(join(f.directory, "cloned", "a.txt"), "utf8"), "one\n");
  assert.equal(result.after, (await f.at(join(f.directory, "cloned"), "rev-parse", "HEAD")).trim());
  const second = coordinateGitCheckoutWrites(createGitService(f.options), f.coordinator);
  assert.deepEqual(await second.acquireRepository(params), result);
  await assert.rejects(second.previewRepositoryAcquisition(options), /target-exists/);
});

test("目录变化使预览失效，已有目录/穿越/链接目标拒绝，不删除用户文件", async (t) => {
  const f = await fixture(t);
  const options = {
    workspacePath: f.directory,
    mode: "clone" as const,
    targetName: "cloned",
    url: f.root,
  };
  const preview = await f.service.previewRepositoryAcquisition(options);
  await writeFile(join(f.directory, "external.txt"), "keep\n");
  assert.equal(
    (await f.service.acquireRepository({ options, requestId: "stale", preview })).code,
    "stale-preview",
  );
  for (const targetName of ["../outside", ".", "CON", "a/b"]) {
    await assert.rejects(f.service.previewRepositoryAcquisition({ ...options, targetName }));
  }
  await mkdir(join(f.directory, "cloned"));
  await writeFile(join(f.directory, "cloned", "keep.txt"), "user\n");
  await assert.rejects(f.service.previewRepositoryAcquisition(options), /target-exists/);
  await symlink(f.root, join(f.directory, "linked"), "junction");
  await assert.rejects(
    f.service.previewRepositoryAcquisition({ ...options, targetName: "linked" }),
    /target-exists/,
  );
  assert.equal(await readFile(join(f.directory, "cloned", "keep.txt"), "utf8"), "user\n");
});

test("嵌套 init 必须明确选择，活动 Agent 阻止导入", async (t) => {
  const f = await fixture(t);
  const nested = join(f.root, "nested");
  await mkdir(nested);
  assert.equal(
    (await f.acquire({ workspacePath: nested, mode: "init" }, "nested-denied")).code,
    "nested-repository",
  );
  assert.equal(
    (await f.acquire({ workspacePath: nested, mode: "init", allowNested: true }, "nested-allowed"))
      .status,
    "success",
  );
  const lease = await f.coordinator.acquire({
    workspacePath: f.directory,
    ownerId: "agent",
    mode: "shared",
  });
  try {
    await assert.rejects(f.acquire({ workspacePath: f.directory, mode: "init" }), {
      code: "LCODE_CHECKOUT_BUSY",
    });
  } finally {
    await f.coordinator.release(lease);
  }
});

test("clone 失败保留目录与 reservation，显式核对后解除，URL 不进入收据", async (t) => {
  const f = await fixture(t);
  const options = {
    workspacePath: f.directory,
    mode: "clone" as const,
    targetName: "partial",
    url: join(f.base, "missing.git"),
  };
  const result = await f.acquire(options, "failed-clone");
  assert.equal(result.status, "unknown");
  assert.ok(result.targetPath);
  assert.doesNotMatch(JSON.stringify(result), /missing\.git/);
  await assert.rejects(
    f.coordinator.acquire({
      workspacePath: f.directory,
      ownerId: "agent",
      mode: "shared",
      waitMs: 0,
    }),
    { code: "LCODE_CHECKOUT_RESERVED" },
  );
  const preview = await f.service.previewGitOperationCompletion({
    workspacePath: f.directory,
    requestId: "failed-clone",
  });
  assert.equal(preview.needsNativeConfirmation, true);
  const complete = await f.service.completeGitOperation({
    workspacePath: f.directory,
    requestId: "ack",
    sourceRequestId: "failed-clone",
    expectedRevision: preview.revision,
    confirmNativeStopped: true,
  });
  assert.equal(complete.status, "success");
  assert.equal((await lstat(join(f.directory, "partial"))).isDirectory(), true);
});

test("clone 目标不存在仍可在父目录 writer 下核对恢复，不自动重建", async (t) => {
  const f = await fixture(t);
  const result = await f.acquire(
    {
      workspacePath: f.directory,
      mode: "clone",
      targetName: "missing-target",
      url: join(f.base, "missing.git"),
    },
    "missing-target",
  );
  assert.equal(result.status, "unknown");
  await rmdir(join(f.directory, "missing-target"));
  const preview = await f.service.previewGitOperationCompletion({
    workspacePath: f.directory,
    requestId: "missing-target",
  });
  assert.equal(
    (
      await f.service.completeGitOperation({
        workspacePath: f.directory,
        requestId: "complete-missing",
        sourceRequestId: "missing-target",
        expectedRevision: preview.revision,
        confirmNativeStopped: true,
      })
    ).status,
    "success",
  );
  await assert.rejects(lstat(join(f.directory, "missing-target")), { code: "ENOENT" });
  await f.coordinator.assertAdmission!({ workspacePath: f.directory });
});
