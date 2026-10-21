import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { join } from "node:path";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { publishFixture } from "./gitPublishTestHelpers.js";
import { createGitService } from "./gitService.js";
import { coordinateGitCheckoutWrites } from "./gitCheckoutCoordination.js";
import { createCheckoutCoordinator } from "../worktree/node.js";

async function fixture(t: TestContext, wrap?: Parameters<typeof publishFixture>[1]) {
  const f = await publishFixture(t, wrap);
  const options = {
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
  );
  const scope = f.request;
  const start = async (mode: "merge" | "rebase", requestId = "start") => {
    const preview = await service.previewIntegration({
      ...scope,
      mode,
      targetRef: "refs/heads/topic",
    });
    return service.startIntegration({ ...scope, requestId, preview });
  };
  const action = async (requestId: string, confirmDiscard = false) => ({
    ...scope,
    requestId,
    sourceRequestId: "start",
    expectedRevision: (await service.getIntegrationSnapshot(scope)).revision,
    confirmDiscard,
    confirmNativeStopped: false,
  });
  const resolve = async (text: string, id: string) => {
    const command = async () => ({
      ...scope,
      requestId: id,
      sourceRequestId: "start",
      path: "a.txt",
      expectedRevision: (await service.getConflictFile({ ...scope, path: "a.txt" })).revision,
      confirmNativeStopped: false,
    });
    assert.equal(
      (await service.saveConflictResult({ ...(await command()), action: "save", text })).status,
      "success",
    );
    assert.equal(
      (
        await service.markConflictResolved({
          ...(await command()),
          requestId: id + "-mark",
          confirmSpecial: false,
        })
      ).status,
      "success",
    );
  };
  const diverge = async (second = false) => {
    const head = (await f.git("rev-parse", "HEAD")).trim();
    await f.git("checkout", "-qb", "topic");
    await writeFile(join(f.root, "a.txt"), "topic\n");
    await f.git("commit", "-qam", "topic");
    await f.git("checkout", "-q", "main");
    await writeFile(join(f.root, "a.txt"), "main one\n");
    await f.git("commit", "-qam", "main one");
    if (second) {
      await writeFile(join(f.root, "a.txt"), "main two\n");
      await f.git("commit", "-qam", "main two");
    }
    return head;
  };
  return { ...f, options, service, scope, start, action, resolve, diverge };
}

test("Merge 冲突复用 E1 owner，保存/标记后显式继续，重复请求不再提交", async (t) => {
  const f = await fixture(t);
  await f.diverge();
  const before = (await f.git("rev-parse", "HEAD")).trim();
  assert.equal((await f.start("merge")).status, "conflict");
  assert.equal((await f.service.getConflictSnapshot(f.scope)).sourceRequestId, "start");
  await assert.rejects(f.service.stagePaths({ ...f.scope, paths: ["a.txt"] }), {
    code: "LCODE_CHECKOUT_RESERVED",
  });
  await f.resolve("merged\n", "resolution");
  assert.equal((await f.git("rev-parse", "HEAD")).trim(), before);
  const command = await f.action("continue");
  assert.equal((await f.service.continueIntegration(command)).status, "success");
  const after = (await f.git("rev-parse", "HEAD")).trim();
  assert.notEqual(after, before);
  assert.equal((await f.service.continueIntegration(command)).status, "success");
  assert.equal((await f.git("rev-parse", "HEAD")).trim(), after);
  assert.equal(
    await f.options.checkoutCoordinator.getReservation!({ workspacePath: f.root }),
    null,
  );
  assert.equal(
    (await f.service.getNetworkOperation({ ...f.scope, requestId: "start" }))?.resolved,
    true,
  );
});

test("Rebase 多次冲突保持原 owner；跨 Host 重建后继续，最终恢复分支", async (t) => {
  const f = await fixture(t);
  await f.diverge(true);
  assert.equal((await f.start("rebase")).status, "conflict");
  const snapshot = await f.service.getIntegrationSnapshot(f.scope);
  assert.equal(snapshot.nativeMode, "rebase");
  assert.ok(snapshot.progress);
  await f.resolve("resolved first\n", "first");
  const second = coordinateGitCheckoutWrites(
    createGitService(f.options),
    createCheckoutCoordinator({ dataDir: join(f.base, "coord"), git: f.command }),
  );
  assert.equal(
    (await second.continueIntegration(await f.action("continue-one"))).status,
    "conflict",
  );
  assert.equal((await f.service.getConflictSnapshot(f.scope)).sourceRequestId, "start");
  await f.resolve("resolved second\n", "second");
  assert.equal(
    (await f.service.continueIntegration(await f.action("continue-two"))).status,
    "success",
  );
  assert.equal((await f.git("branch", "--show-current")).trim(), "main");
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "resolved second\n");
});

for (const mode of ["merge", "rebase"] as const)
  test(`${mode} 中止需要明确确认并恢复原 HEAD；旧预览/其它 identity 不可写入`, async (t) => {
    const f = await fixture(t);
    await f.diverge();
    const before = (await f.git("rev-parse", "HEAD")).trim();
    await f.start(mode);
    const stale = await f.action("stale", true);
    await writeFile(join(f.root, "a.txt"), "manual edits\n");
    assert.equal((await f.service.abortIntegration(stale)).status, "failed");
    assert.equal(
      (await f.service.abortIntegration(await f.action("unconfirmed"))).status,
      "failed",
    );
    const valid = await f.action("abort", true);
    assert.equal(
      (await f.service.getIntegrationSnapshot({ ...f.scope, workspaceIdentity: "other" })).blocked,
      true,
    );
    await assert.rejects(
      f.service.abortIntegration({ ...valid, requestId: "other", workspaceIdentity: "other" }),
      /Missing original/,
    );
    assert.equal((await f.service.abortIntegration(valid)).status, "success");
    assert.equal((await f.git("rev-parse", "HEAD")).trim(), before);
    assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "main one\n");
  });

test("发起预览冻结目标且拒绝 dirty、移动目标和 ignored 文件碰撞", async (t) => {
  const f = await fixture(t);
  await f.git("checkout", "-qb", "topic");
  await writeFile(join(f.root, "added.txt"), "topic\n");
  await f.git("add", ".");
  await f.git("commit", "-qm", "add");
  await f.git("checkout", "-q", "main");
  const preview = await f.service.previewIntegration({
    ...f.scope,
    mode: "merge",
    targetRef: "refs/heads/topic",
  });
  await f.git("update-ref", "refs/heads/topic", "main");
  assert.equal(
    (await f.service.startIntegration({ ...f.scope, requestId: "stale", preview })).code,
    "stale-preview",
  );
  await writeFile(join(f.root, "a.txt"), "dirty\n");
  await assert.rejects(
    f.service.previewIntegration({ ...f.scope, mode: "merge", targetRef: "refs/heads/topic" }),
    /dirty-checkout/,
  );
  await f.git("checkout", "--", "a.txt");
  await f.git("update-ref", "refs/heads/topic", preview.target);
  await writeFile(join(f.root, ".git", "info", "exclude"), "added.txt\n");
  await writeFile(join(f.root, "added.txt"), "ignored user data\n");
  await assert.rejects(
    f.service.previewIntegration({ ...f.scope, mode: "rebase", targetRef: "refs/heads/topic" }),
    /ignored-collision/,
  );
  assert.equal(await readFile(join(f.root, "added.txt"), "utf8"), "ignored user data\n");
});

for (const mode of ["merge", "rebase"] as const)
  test(`${mode} 无冲突成功与已包含目标都结算并解除保留`, async (t) => {
    const f = await fixture(t);
    await f.git("checkout", "-qb", "topic");
    await writeFile(join(f.root, "new.txt"), "new\n");
    await f.git("add", ".");
    await f.git("commit", "-qm", "topic");
    await f.git("checkout", "-q", "main");
    if (mode === "rebase") {
      await writeFile(join(f.root, "b.txt"), "local\n");
      await f.git("commit", "-qam", "local");
    }
    assert.equal((await f.start(mode)).status, "success");
    assert.equal((await f.start(mode, "again")).status, "success");
    assert.equal((await f.service.getIntegrationSnapshot(f.scope)).operation, null);
    assert.equal((await f.git("branch", "--show-current")).trim(), "main");
    assert.equal(await readFile(join(f.root, "new.txt"), "utf8"), "new\n");
  });

test("Continue 拒绝未暂存修改/未跟踪文件，Abort 拒绝覆盖后来新增的忽略文件", async (t) => {
  const f = await fixture(t);
  await f.diverge();
  await f.start("rebase");
  await f.resolve("resolved\n", "resolved");
  await writeFile(join(f.root, "b.txt"), "unstaged\n");
  assert.equal((await f.service.getIntegrationSnapshot(f.scope)).canContinue, false);
  assert.equal(
    (await f.service.continueIntegration(await f.action("dirty"))).code,
    "integration-not-ready",
  );
  await f.git("rm", "-qf", "b.txt");
  await writeFile(join(f.root, ".git", "info", "exclude"), "b.txt\n");
  await writeFile(join(f.root, "b.txt"), "ignored after start\n");
  assert.equal(
    (await f.service.abortIntegration(await f.action("collision", true))).code,
    "ignored-collision",
  );
  assert.equal(await readFile(join(f.root, "b.txt"), "utf8"), "ignored after start\n");
});

test("外部 Merge 不可借 E2 Continue/Abort；伪造 Rebase todo、marker 或 index.lock 使确认失效", async (t) => {
  const f = await fixture(t);
  await f.diverge();
  await assert.rejects(f.git("merge", "topic"));
  const snapshot = await f.service.getIntegrationSnapshot(f.scope);
  assert.equal(snapshot.canContinue, false);
  assert.equal(snapshot.canAbort, false);
  assert.equal(snapshot.operation, null);
  await f.git("merge", "--abort");
  await f.start("rebase");
  await writeFile(join(f.root, ".git", "index.lock"), "external lock");
  assert.equal((await f.service.getIntegrationSnapshot(f.scope)).canAbort, false);
  await unlink(join(f.root, ".git", "index.lock"));
  await writeFile(join(f.root, ".git", "rebase-merge", "git-rebase-todo"), "exec echo unsafe\n");
  assert.equal((await f.service.getIntegrationSnapshot(f.scope)).canContinue, false);
  assert.equal((await f.service.getIntegrationSnapshot(f.scope)).canAbort, false);
  assert.equal(
    (await f.service.abortIntegration(await f.action("no-adopt", true))).code,
    "integration-not-ready",
  );
});

test("原生命令未退出时保留原 journal、reservation 和 writer，重建 Host 不自动重放", async (t) => {
  let count = 0;
  const f = await fixture(t, (command) => ({
    ...command,
    run: async (options) => {
      if (options.args.includes("merge") && options.args.includes("--ff")) {
        count++;
        return {
          binaryPath: "git",
          cwd: options.cwd,
          args: options.args,
          stdout: "",
          stderr: "",
          exitCode: null,
          signal: null,
          durationMs: 1,
          timedOut: true,
          outputTruncated: false,
          orphaned: true,
        };
      }
      return command.run(options);
    },
  }));
  await f.diverge();
  const preview = await f.service.previewIntegration({
    ...f.scope,
    mode: "merge",
    targetRef: "refs/heads/topic",
  });
  const command = { ...f.scope, requestId: "start", preview };
  const result = await f.service.startIntegration(command);
  assert.equal(result.unsettled, true);
  assert.equal(count, 1);
  const second = coordinateGitCheckoutWrites(
    createGitService(f.options),
    createCheckoutCoordinator({ dataDir: join(f.base, "coord"), git: f.command }),
  );
  assert.equal((await second.startIntegration(command)).status, "unknown");
  assert.equal(count, 1);
  await assert.rejects(second.stagePaths({ ...f.scope, paths: ["a.txt"] }), {
    code: "LCODE_CHECKOUT_BUSY",
  });
  const recovery = await second.previewGitOperationCompletion({ ...f.scope, requestId: "start" });
  assert.equal(recovery.needsNativeConfirmation, true);
  assert.ok(await f.options.checkoutCoordinator.getReservation!({ workspacePath: f.root }));
});

test("原生超时已退出仍保留恢复边界，显式核对解除且不重放", async (t) => {
  let count = 0;
  const f = await fixture(t, (command) => ({
    ...command,
    run: async (options) => {
      if (options.args.includes("merge") && options.args.includes("--ff")) {
        count++;
        const result = await command.run(options);
        return { ...result, timedOut: true };
      }
      return command.run(options);
    },
  }));
  await f.git("branch", "topic");
  assert.equal((await f.start("merge")).status, "unknown");
  const preview = await f.service.previewGitOperationCompletion({ ...f.scope, requestId: "start" });
  assert.ok(preview.canComplete);
  assert.ok(preview.needsNativeConfirmation);
  assert.equal(
    (
      await f.service.completeGitOperation({
        ...f.scope,
        requestId: "finish",
        sourceRequestId: "start",
        expectedRevision: preview.revision,
        confirmNativeStopped: true,
      })
    ).status,
    "success",
  );
  assert.equal(count, 1);
});

test("拒绝隐藏修改、分离 HEAD、无共同祖先与会丢失拓扑的 Rebase", async (t) => {
  const f = await fixture(t);
  await f.git("branch", "topic");
  const preview = () =>
    f.service.previewIntegration({ ...f.scope, mode: "rebase", targetRef: "refs/heads/topic" });
  await f.git("update-index", "--assume-unchanged", "a.txt");
  await assert.rejects(preview(), /unsupported-checkout/);
  await f.git("update-index", "--no-assume-unchanged", "a.txt");
  await f.git("checkout", "--detach", "-q");
  await assert.rejects(preview(), /detached/);
  await f.git("checkout", "-q", "main");
  await f.git("checkout", "-q", "--orphan", "unrelated");
  await f.git("rm", "-qrf", ".");
  await writeFile(join(f.root, "c.txt"), "unrelated\n");
  await f.git("add", ".");
  await f.git("commit", "-qm", "unrelated");
  await f.git("checkout", "-q", "main");
  await assert.rejects(
    f.service.previewIntegration({ ...f.scope, mode: "merge", targetRef: "refs/heads/unrelated" }),
    /unrelated-histories/,
  );
  await f.git("checkout", "-qb", "nested");
  await writeFile(join(f.root, "a.txt"), "nested\n");
  await f.git("commit", "-qam", "nested");
  await f.git("checkout", "-q", "main");
  await f.git("merge", "--no-ff", "--no-edit", "nested");
  await assert.rejects(preview(), /unsupported-rebase-topology/);
});

test("Agent 占用拒绝发起；冲突保留不阻止独立 linked checkout 的文件写入", async (t) => {
  const f = await fixture(t);
  await f.diverge();
  const preview = await f.service.previewIntegration({
    ...f.scope,
    mode: "merge",
    targetRef: "refs/heads/topic",
  });
  const permit = await f.options.checkoutCoordinator.acquire({
    workspacePath: f.root,
    ownerId: "agent",
    mode: "shared",
    waitMs: 0,
  });
  try {
    await assert.rejects(f.service.startIntegration({ ...f.scope, requestId: "busy", preview }), {
      code: "LCODE_CHECKOUT_BUSY",
    });
  } finally {
    await f.options.checkoutCoordinator.release(permit);
  }
  const other = join(f.base, "other");
  await f.git("worktree", "add", "-qb", "other", other);
  await f.start("merge");
  await writeFile(join(other, "a.txt"), "independent\n");
  await f.service.stagePaths({ workspacePath: other, paths: ["a.txt"] });
  assert.match(await f.at(other, "diff", "--cached"), /independent/);
});

test("Continue 未结算会标记原 owner unsettled，重复子命令不重放", async (t) => {
  let continued = 0;
  const f = await fixture(t, (command) => ({
    ...command,
    run: async (options) => {
      const result = await command.run(options);
      if (options.args.includes("--continue")) {
        continued++;
        return { ...result, timedOut: true, orphaned: true };
      }
      return result;
    },
  }));
  await f.diverge();
  await f.start("merge");
  await f.resolve("resolved\n", "resolved");
  const params = await f.action("continue");
  assert.equal((await f.service.continueIntegration(params)).unsettled, true);
  assert.equal(
    (await f.service.getNetworkOperation({ ...f.scope, requestId: "start" }))?.unsettled,
    true,
  );
  assert.equal((await f.service.continueIntegration(params)).status, "unknown");
  assert.equal(continued, 1);
  assert.equal(
    (await f.service.previewGitOperationCompletion({ ...f.scope, requestId: "start" }))
      .needsNativeConfirmation,
    true,
  );
  await assert.rejects(f.service.stagePaths({ ...f.scope, paths: ["a.txt"] }), {
    code: "LCODE_CHECKOUT_BUSY",
  });
});
