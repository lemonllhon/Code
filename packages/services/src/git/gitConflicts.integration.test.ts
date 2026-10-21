import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { join, resolve } from "node:path";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { publishFixture } from "./gitPublishTestHelpers.js";
import { createGitService } from "./gitService.js";
import { coordinateGitCheckoutWrites } from "./gitCheckoutCoordination.js";
import { createCheckoutCoordinator } from "../worktree/node.js";

async function fixture(t: TestContext, wrap?: Parameters<typeof publishFixture>[1]) {
  const f = await publishFixture(t, wrap),
    options = {
      commandProvider: f.command,
      reviewStateDataDir: join(f.base, "receipts"),
      checkoutCoordinator: createCheckoutCoordinator({
        dataDir: join(f.base, "coord"),
        git: f.command,
      }),
    };
  const service = coordinateGitCheckoutWrites(
      createGitService(options),
      options.checkoutCoordinator,
    ),
    scope = f.request;
  const conflict = async () => {
    await writeFile(join(f.root, "a.txt"), "stash-side\n");
    await service.saveStash({
      ...scope,
      requestId: "save",
      expectedRevision: (await service.getStashSnapshot(scope)).revision,
      expectedState: await service.getPublishState(scope),
      includeUntracked: false,
      message: "keep",
    });
    await writeFile(join(f.root, "a.txt"), "head-side\n");
    await f.git("commit", "-qam", "head-side");
    const list = await service.getStashSnapshot(scope);
    const applied = await service.applyStash({
      ...scope,
      requestId: "apply",
      oid: list.entries[0]!.oid,
      expectedRevision: list.revision,
      expectedState: await service.getPublishState(scope),
      restoreIndex: false,
    });
    assert.equal(applied.status, "conflict");
    return applied;
  };
  const command = async (requestId: string, path = "a.txt") => ({
    ...scope,
    requestId,
    sourceRequestId: (await service.getConflictSnapshot(scope)).sourceRequestId!,
    path,
    expectedRevision: (await service.getConflictFile({ ...scope, path })).revision,
    confirmNativeStopped: false,
  });
  return { ...f, gitCommand: f.command, options, service, scope, conflict, command };
}

test("真实 Stash 三方与结果分别读取；保存不解冲突，标记只处理当前文件并保持原 owner", async (t) => {
  const f = await fixture(t);
  await f.conflict();
  const snapshot = await f.service.getConflictSnapshot(f.scope);
  assert.equal(snapshot.operation, "stash");
  assert.equal(snapshot.sourceRequestId, "apply");
  const file = await f.service.getConflictFile({ ...f.scope, path: "a.txt" });
  assert.equal(file.base.text, "one\n");
  assert.equal(file.ours.text, "head-side\n");
  assert.equal(file.theirs.text, "stash-side\n");
  assert.match(file.result.text!, /<<<<<<</);
  await writeFile(join(f.root, "b.txt"), "unrelated\n");
  const params = {
    ...(await f.command("manual-save")),
    action: "save" as const,
    text: "人工解决\r\n",
  };
  const saved = await f.service.saveConflictResult(params);
  assert.equal(saved.status, "success");
  assert.equal(saved.filePath, "a.txt");
  assert.equal((await f.service.getConflictSnapshot(f.scope)).files.length, 1);
  assert.deepEqual(await f.service.saveConflictResult(params), saved);
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "人工解决\r\n");
  const staged = await f.service.markConflictResolved({
    ...(await f.command("mark")),
    confirmSpecial: false,
  });
  assert.equal(staged.status, "success");
  assert.equal((await f.service.getConflictSnapshot(f.scope)).files.length, 0);
  assert.equal((await f.service.getStashSnapshot(f.scope)).blocked, true);
  assert.match(await f.git("show", ":a.txt"), /人工解决/);
  assert.equal(await f.git("show", ":b.txt"), "two\n");
  const preview = await f.service.previewGitOperationCompletion({ ...f.scope, requestId: "apply" });
  assert.equal(preview.canComplete, true);
  assert.equal(
    (
      await f.service.completeGitOperation({
        ...f.scope,
        sourceRequestId: "apply",
        requestId: "finish",
        expectedRevision: preview.revision,
        confirmNativeStopped: false,
      })
    ).status,
    "success",
  );
  assert.equal((await f.service.getStashSnapshot(f.scope)).entries.length, 1);
});

test("外部 merge 只读不接管，显式开始后重启保留，原生完成后才能解除", async (t) => {
  const f = await fixture(t);
  await f.git("checkout", "-qb", "other");
  await writeFile(join(f.root, "a.txt"), "other\n");
  await f.git("commit", "-qam", "other");
  await f.git("checkout", "-q", "main");
  await writeFile(join(f.root, "a.txt"), "main\n");
  await f.git("commit", "-qam", "main");
  await f.git("merge", "--no-edit", "other").catch(() => {});
  const snapshot = await f.service.getConflictSnapshot(f.scope);
  assert.equal(snapshot.operation, "merge");
  assert.equal(snapshot.sourceRequestId, null);
  assert.equal(await f.options.checkoutCoordinator.getReservation!(f.scope), null);
  const began = await f.service.beginConflictResolution({
    ...f.scope,
    requestId: "adopt",
    expectedRevision: snapshot.revision,
  });
  assert.equal(began.status, "conflict");
  const restarted = createCheckoutCoordinator({
    dataDir: join(f.base, "coord"),
    git: f.gitCommand,
  });
  await assert.rejects(
    restarted.acquire({ workspacePath: f.root, ownerId: "agent", mode: "shared", waitMs: 0 }),
    { code: "LCODE_CHECKOUT_RESERVED" },
  );
  assert.equal(
    (
      await f.service.saveConflictResult({
        ...(await f.command("save")),
        action: "save",
        text: "merged\n",
      })
    ).status,
    "success",
  );
  assert.equal(
    (await f.service.markConflictResolved({ ...(await f.command("mark")), confirmSpecial: false }))
      .status,
    "success",
  );
  assert.equal(
    (await f.service.previewGitOperationCompletion({ ...f.scope, requestId: "adopt" })).canComplete,
    false,
  );
  await f.git("commit", "-qm", "merge done");
  const preview = await f.service.previewGitOperationCompletion({ ...f.scope, requestId: "adopt" });
  assert.equal(preview.canComplete, true);
  assert.equal(
    (
      await f.service.completeGitOperation({
        ...f.scope,
        requestId: "finish",
        sourceRequestId: "adopt",
        expectedRevision: preview.revision,
        confirmNativeStopped: false,
      })
    ).status,
    "success",
  );
  await restarted.assertAdmission!(f.scope);
});

test("外部文件与 index 变化拒绝旧确认，原生锁不能删除；另一 identity 不能穿过保留", async (t) => {
  const f = await fixture(t);
  await f.conflict();
  const frozen = {
    ...(await f.command("stale-file")),
    action: "save" as const,
    text: "overwrite\n",
  };
  await writeFile(join(f.root, "a.txt"), "external\n");
  assert.equal((await f.service.saveConflictResult(frozen)).code, "stale-conflict");
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "external\n");
  const next = {
    ...(await f.command("stale-index")),
    action: "save" as const,
    text: "overwrite\n",
  };
  await f.git("add", "b.txt");
  // add 同内容可能保留 index；显式修改其它暂存项制造版本变化。
  await writeFile(join(f.root, "b.txt"), "staged\n");
  await f.git("add", "b.txt");
  assert.equal((await f.service.saveConflictResult(next)).code, "stale-conflict");
  const lock = join(f.root, ".git", "index.lock");
  await writeFile(lock, "outside-owner");
  assert.equal(
    (
      await f.service.saveConflictResult({
        ...(await f.command("locked")),
        action: "save",
        text: "no",
      })
    ).code,
    "git-lock-busy",
  );
  assert.equal(await readFile(lock, "utf8"), "outside-owner");
  await unlink(lock);
  const other = await f.service.getConflictSnapshot({
    workspacePath: f.root,
    workspaceIdentity: "other",
  });
  assert.equal(other.blocked, true);
  assert.equal(other.sourceRequestId, null);
  await assert.rejects(
    f.service.saveConflictResult({
      ...(await f.command("wrong-owner")),
      workspaceIdentity: "other",
      action: "save",
      text: "no",
    }),
    /Missing original/,
  );
  assert.equal(
    resolve(snapshotRoot(await f.service.getConflictSnapshot(f.scope))),
    resolve(f.root),
  );
});
const snapshotRoot = (snapshot: { root: string }) => snapshot.root;

test("真实 Rebase 使用目标侧 stage 2、重放侧 stage 3，人工标记不隐式继续", async (t) => {
  const f = await fixture(t);
  await f.git("checkout", "-qb", "topic");
  await writeFile(join(f.root, "a.txt"), "topic-side\n");
  await f.git("commit", "-qam", "topic");
  await f.git("checkout", "-q", "main");
  await writeFile(join(f.root, "a.txt"), "target-side\n");
  await f.git("commit", "-qam", "target");
  await f.git("checkout", "-q", "topic");
  await f.git("rebase", "main").catch(() => {});
  const snapshot = await f.service.getConflictSnapshot(f.scope);
  assert.equal(snapshot.operation, "rebase");
  const file = await f.service.getConflictFile({ ...f.scope, path: "a.txt" });
  assert.equal(file.ours.text, "target-side\n");
  assert.equal(file.theirs.text, "topic-side\n");
  assert.equal(
    (
      await f.service.beginConflictResolution({
        ...f.scope,
        requestId: "adopt-rebase",
        expectedRevision: snapshot.revision,
      })
    ).status,
    "conflict",
  );
  assert.equal(
    (
      await f.service.saveConflictResult({
        ...(await f.command("save-rebase")),
        action: "save",
        text: "resolved\n",
      })
    ).status,
    "success",
  );
  assert.equal(
    (
      await f.service.markConflictResolved({
        ...(await f.command("mark-rebase")),
        confirmSpecial: false,
      })
    ).status,
    "success",
  );
  assert.equal(
    (await f.service.previewGitOperationCompletion({ ...f.scope, requestId: "adopt-rebase" }))
      .canComplete,
    false,
  );
  await f.git("-c", "core.editor=true", "rebase", "--continue");
  assert.equal(
    (await f.service.previewGitOperationCompletion({ ...f.scope, requestId: "adopt-rebase" }))
      .canComplete,
    true,
  );
  assert.equal(await f.git("branch", "--show-current"), "topic\n");
});
