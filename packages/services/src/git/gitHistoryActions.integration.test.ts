import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { historyFixture } from "./gitHistoryTestHelpers.js";

for (const mode of ["cherry-pick", "revert"] as const)
  for (const abort of [false, true])
    test(`${mode} 冲突后原 owner 人工解决，再${abort ? "中止" : "继续"}，重复请求不重放`, async (t) => {
      const f = await historyFixture(t),
        base = (await f.git("rev-parse", "HEAD")).trim();
      await writeFile(join(f.root, "a.txt"), "topic\n");
      await f.git("commit", "-qam", "topic");
      const target = (await f.git("rev-parse", "HEAD")).trim();
      if (mode === "cherry-pick") await f.git("checkout", "-qb", "other", base);
      await writeFile(join(f.root, "a.txt"), "later\n");
      await f.git("commit", "-qam", "later");
      const before = (await f.git("rev-parse", "HEAD")).trim();
      const preview = await f.service.previewIntegration({ ...f.scope, mode, targetRef: target });
      assert.equal(
        (await f.service.startIntegration({ ...f.scope, requestId: "start", preview })).status,
        "conflict",
      );
      const selected = async (requestId: string) => ({
        ...f.scope,
        requestId,
        sourceRequestId: "start",
        path: "a.txt",
        expectedRevision: (await f.service.getConflictFile({ ...f.scope, path: "a.txt" })).revision,
        confirmNativeStopped: false,
      });
      assert.equal((await f.service.getConflictSnapshot(f.scope)).sourceRequestId, "start");
      assert.equal(
        (
          await f.service.saveConflictResult({
            ...(await selected("save")),
            action: "save",
            text: "resolved\n",
          })
        ).status,
        "success",
      );
      assert.equal(
        (
          await f.service.markConflictResolved({
            ...(await selected("mark")),
            confirmSpecial: false,
          })
        ).status,
        "success",
      );
      const command = {
        ...f.scope,
        requestId: "action",
        sourceRequestId: "start",
        expectedRevision: (await f.service.getIntegrationSnapshot(f.scope)).revision,
        confirmDiscard: abort,
        confirmNativeStopped: false,
      };
      const result = await (abort
        ? f.service.abortIntegration(command)
        : f.service.continueIntegration(command));
      assert.equal(result.status, "success", JSON.stringify(result));
      const after = (await f.git("rev-parse", "HEAD")).trim();
      assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), abort ? "later\n" : "resolved\n");
      assert.equal(after === before, abort);
      await (abort ? f.service.abortIntegration(command) : f.service.continueIntegration(command));
      assert.equal((await f.git("rev-parse", "HEAD")).trim(), after);
      assert.equal(await f.coordinator.getReservation!(f.scope), null);
    });

test("Cherry-pick 允许无共同祖先的根提交；Revert 不可达及 merge commit 缺 mainline 拒绝", async (t) => {
  const f = await historyFixture(t);
  await f.git("checkout", "-q", "--orphan", "orphan");
  await f.git("rm", "-qrf", ".");
  await writeFile(join(f.root, "other.txt"), "other\n");
  await f.git("add", ".");
  await f.git("commit", "-qm", "root");
  const target = (await f.git("rev-parse", "HEAD")).trim();
  await f.git("checkout", "-q", "main");
  await assert.rejects(
    f.service.previewIntegration({ ...f.scope, mode: "revert", targetRef: target }),
    /unreachable-commit/,
  );
  const preview = await f.service.previewIntegration({
    ...f.scope,
    mode: "cherry-pick",
    targetRef: target,
  });
  assert.equal(
    (await f.service.startIntegration({ ...f.scope, requestId: "root", preview })).status,
    "success",
  );
  await f.git("checkout", "-qb", "topic");
  await writeFile(join(f.root, "b.txt"), "topic\n");
  await f.git("commit", "-qam", "topic");
  await f.git("checkout", "-q", "main");
  await f.git("merge", "--no-ff", "--no-edit", "topic");
  await assert.rejects(
    f.service.previewIntegration({
      ...f.scope,
      mode: "revert",
      targetRef: (await f.git("rev-parse", "HEAD")).trim(),
    }),
    /mainline-required/,
  );
});

test("空 Cherry-pick 保留原生现场不自动 skip，标记被外部替换拒绝原 owner 的操作", async (t) => {
  const f = await historyFixture(t),
    target = (await f.git("rev-parse", "HEAD")).trim();
  const preview = await f.service.previewIntegration({
    ...f.scope,
    mode: "cherry-pick",
    targetRef: target,
  });
  const result = await f.service.startIntegration({ ...f.scope, requestId: "empty", preview });
  assert.equal(result.status, "partial");
  assert.equal(result.resolved, false);
  const original = await readFile(join(f.root, ".git", "CHERRY_PICK_HEAD"));
  await writeFile(join(f.root, ".git", "CHERRY_PICK_HEAD"), "f".repeat(40) + "\n");
  assert.equal((await f.service.getIntegrationSnapshot(f.scope)).canAbort, false);
  await writeFile(join(f.root, ".git", "CHERRY_PICK_HEAD"), original);
  const snapshot = await f.service.getIntegrationSnapshot(f.scope);
  assert.equal(
    (
      await f.service.abortIntegration({
        ...f.scope,
        requestId: "abort-empty",
        sourceRequestId: "empty",
        expectedRevision: snapshot.revision,
        confirmDiscard: true,
        confirmNativeStopped: false,
      })
    ).status,
    "success",
  );
  assert.equal((await f.git("rev-parse", "HEAD")).trim(), target);
});

test("Revert 恢复来源 parent 的文件前拒绝覆盖 ignored 内容", async (t) => {
  const f = await historyFixture(t);
  await f.git("rm", "b.txt");
  await f.git("commit", "-qm", "delete b");
  await writeFile(join(f.root, ".git", "info", "exclude"), "b.txt\n");
  await writeFile(join(f.root, "b.txt"), "user ignored data\n");
  await assert.rejects(
    f.service.previewIntegration({
      ...f.scope,
      mode: "revert",
      targetRef: (await f.git("rev-parse", "HEAD")).trim(),
    }),
    /ignored-collision/,
  );
  assert.equal(await readFile(join(f.root, "b.txt"), "utf8"), "user ignored data\n");
});
