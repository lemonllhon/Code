import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { historyFixture } from "./gitHistoryTestHelpers.js";
for (const mode of ["soft", "mixed", "hard"] as const)
  test(`Reset ${mode} 的范围与恢复保留 staged/unstaged，幂等只执行一次`, async (t) => {
    const f = await historyFixture(t),
      target = (await f.git("rev-parse", "HEAD")).trim();
    await writeFile(join(f.root, "a.txt"), "committed\n");
    await f.git("commit", "-qam", "next");
    const before = (await f.git("rev-parse", "HEAD")).trim();
    await writeFile(join(f.root, "a.txt"), "staged\n");
    await f.git("add", "a.txt");
    await writeFile(join(f.root, "a.txt"), "working\n");
    const staged = await f.git("show", ":a.txt");
    const preview = await f.service.previewHistoryReset({ ...f.scope, mode, target });
    assert.equal((await f.git("rev-parse", "HEAD")).trim(), before);
    const request = {
      ...f.scope,
      requestId: `reset-${mode}`,
      preview,
      confirmDiscard: mode === "hard",
    };
    const receipt = await f.service.resetHistory(request);
    assert.equal(receipt.status, "success");
    assert.equal((await f.service.resetHistory(request)).status, "success");
    assert.equal((await f.git("rev-parse", "HEAD")).trim(), target);
    assert.equal(
      await readFile(join(f.root, "a.txt"), "utf8"),
      mode === "hard" ? "one\n" : "working\n",
    );
    if (mode === "soft") assert.equal(await f.git("show", ":a.txt"), staged);
    const recovery = await f.service.previewHistoryResetRecovery({
      ...f.scope,
      requestId: request.requestId,
    });
    const restored = await f.service.resetHistory({
      ...f.scope,
      requestId: `restore-${mode}`,
      preview: recovery,
      confirmDiscard: true,
    });
    assert.equal(restored.status, "success");
    assert.equal((await f.git("rev-parse", "HEAD")).trim(), before);
    assert.equal(await f.git("show", ":a.txt"), staged);
    assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "working\n");
  });
test("Reset stale/hard 未确认拒绝，恢复拒绝新改动及改写的备份 ref", async (t) => {
  const f = await historyFixture(t),
    target = (await f.git("rev-parse", "HEAD")).trim();
  await writeFile(join(f.root, "a.txt"), "next\n");
  await f.git("commit", "-qam", "next");
  const preview = await f.service.previewHistoryReset({ ...f.scope, target, mode: "hard" });
  assert.equal(
    (
      await f.service.resetHistory({
        ...f.scope,
        requestId: "no-confirm",
        preview,
        confirmDiscard: false,
      })
    ).status,
    "failed",
  );
  await writeFile(join(f.root, "a.txt"), "changed\n");
  assert.equal(
    (
      await f.service.resetHistory({
        ...f.scope,
        requestId: "stale",
        preview,
        confirmDiscard: true,
      })
    ).status,
    "failed",
  );
  const fresh = await f.service.previewHistoryReset({ ...f.scope, target, mode: "hard" });
  assert.equal(
    (
      await f.service.resetHistory({
        ...f.scope,
        requestId: "valid",
        preview: fresh,
        confirmDiscard: true,
      })
    ).status,
    "success",
  );
  await writeFile(join(f.root, "a.txt"), "new draft\n");
  await assert.rejects(
    f.service.previewHistoryResetRecovery({ ...f.scope, requestId: "valid" }),
    /stale-recovery/,
  );
  await writeFile(join(f.root, "a.txt"), "one\n");
  const receipt = await f.service.getNetworkOperation({ ...f.scope, requestId: "valid" });
  await f.git("update-ref", receipt!.historyReset!.backupRef, target);
  await assert.rejects(
    f.service.previewHistoryResetRecovery({ ...f.scope, requestId: "valid" }),
    /stale-recovery/,
  );
});
test("mixed 将原 tracked 文件保留为 untracked 时仍可依据原 index 恢复", async (t) => {
  const f = await historyFixture(t),
    target = (await f.git("rev-parse", "HEAD")).trim();
  await writeFile(join(f.root, "added.txt"), "preserved\n");
  await f.git("add", ".");
  await f.git("commit", "-qm", "added");
  const before = (await f.git("rev-parse", "HEAD")).trim();
  const preview = await f.service.previewHistoryReset({ ...f.scope, target, mode: "mixed" });
  assert.equal(
    (
      await f.service.resetHistory({
        ...f.scope,
        requestId: "mixed-add",
        preview,
        confirmDiscard: false,
      })
    ).status,
    "success",
  );
  const recovery = await f.service.previewHistoryResetRecovery({
    ...f.scope,
    requestId: "mixed-add",
  });
  assert.equal(
    (
      await f.service.resetHistory({
        ...f.scope,
        requestId: "restore-add",
        preview: recovery,
        confirmDiscard: true,
      })
    ).status,
    "success",
  );
  assert.equal((await f.git("rev-parse", "HEAD")).trim(), before);
  assert.equal(await readFile(join(f.root, "added.txt"), "utf8"), "preserved\n");
});
for (const orphaned of [false, true])
  test(`Reset 原生结果未知不重放，${orphaned ? "孤儿进程继续持有 lease" : "reservation 保留至明确对账"}`, async (t) => {
    let count = 0;
    const f = await historyFixture(t, (command) => ({
      ...command,
      run: async (params) => {
        const result = await command.run(params);
        if (params.args.includes("reset")) {
          count++;
          return { ...result, timedOut: !orphaned, orphaned };
        }
        return result;
      },
    }));
    const target = (await f.git("rev-parse", "HEAD")).trim();
    const preview = await f.service.previewHistoryReset({ ...f.scope, target, mode: "soft" });
    const request = { ...f.scope, requestId: "unknown-reset", preview, confirmDiscard: false };
    const receipt = await f.service.resetHistory(request);
    assert.equal(receipt.status, "unknown");
    assert.equal(receipt.unsettled, orphaned);
    assert.equal((await f.service.resetHistory(request)).status, "unknown");
    assert.equal(count, 1);
    await assert.rejects(
      f.service.createBranchAndSwitch({ ...f.scope, branchName: "blocked" } as any),
      { code: orphaned ? "LCODE_CHECKOUT_BUSY" : "LCODE_CHECKOUT_RESERVED" },
    );
    if (!orphaned) {
      const recovery = await f.service.previewGitOperationCompletion({
        ...f.scope,
        requestId: request.requestId,
      });
      const finish = {
        ...f.scope,
        requestId: "finish-unknown",
        sourceRequestId: request.requestId,
        expectedRevision: recovery.revision,
        confirmNativeStopped: true,
      };
      assert.equal((await f.service.completeGitOperation(finish)).status, "success");
      assert.equal(
        (await f.service.getNetworkOperation({ ...f.scope, requestId: request.requestId }))
          ?.resolved,
        true,
      );
    }
  });
