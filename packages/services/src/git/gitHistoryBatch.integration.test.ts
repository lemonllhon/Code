import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { historyFixture } from "./gitHistoryTestHelpers.js";
test("一个 sequencer 按给定顺序摘取/撤销两个提交，同 request 幂等", async (t) => {
  const f = await historyFixture(t),
    base = (await f.git("rev-parse", "HEAD")).trim();
  await f.git("checkout", "-qb", "topic");
  const targets: string[] = [];
  for (const name of ["one", "two"]) {
    await writeFile(join(f.root, `${name}.txt`), name);
    await f.git("add", ".");
    await f.git("commit", "-qm", name);
    targets.push((await f.git("rev-parse", "HEAD")).trim());
  }
  await f.git("checkout", "-q", "main");
  const preview = await f.service.previewIntegration({
    ...f.scope,
    mode: "cherry-pick",
    targetRef: targets[0]!,
    targets,
  });
  const request = { ...f.scope, requestId: "batch-pick", preview };
  assert.equal((await f.service.startIntegration(request)).status, "success");
  assert.equal((await f.service.startIntegration(request)).status, "success");
  assert.equal((await f.git("rev-list", "--count", `${base}..HEAD`)).trim(), "2");
  const picked = (await f.git("rev-list", `${base}..HEAD`)).trim().split("\n");
  const reverse = await f.service.previewIntegration({
    ...f.scope,
    mode: "revert",
    targetRef: picked[0]!,
    targets: picked,
  });
  assert.equal(
    (await f.service.startIntegration({ ...f.scope, requestId: "batch-revert", preview: reverse }))
      .status,
    "success",
  );
  assert.equal((await f.git("diff", base, "HEAD")).trim(), "");
});
for (const abort of [false, true])
  test(`第二个提交冲突后的${abort ? "中止恢复起点" : "继续保留整个批次"}`, async (t) => {
    const f = await historyFixture(t);
    await f.git("checkout", "-qb", "topic");
    await writeFile(join(f.root, "one.txt"), "one");
    await f.git("add", ".");
    await f.git("commit", "-qm", "one");
    const first = (await f.git("rev-parse", "HEAD")).trim();
    await writeFile(join(f.root, "a.txt"), "topic\n");
    await f.git("commit", "-qam", "two");
    const second = (await f.git("rev-parse", "HEAD")).trim();
    await f.git("checkout", "-q", "main");
    await writeFile(join(f.root, "a.txt"), "main\n");
    await f.git("commit", "-qam", "main");
    const base = (await f.git("rev-parse", "HEAD")).trim();
    const preview = await f.service.previewIntegration({
      ...f.scope,
      mode: "cherry-pick",
      targetRef: first,
      targets: [first, second],
    });
    assert.equal(
      (await f.service.startIntegration({ ...f.scope, requestId: "conflicted-batch", preview }))
        .status,
      "conflict",
    );
    if (!abort) {
      await writeFile(join(f.root, "a.txt"), "resolved\n");
      await f.git("add", "a.txt");
    }
    const snapshot = await f.service.getIntegrationSnapshot(f.scope);
    assert.equal(abort ? snapshot.canAbort : snapshot.canContinue, true);
    const action = {
      ...f.scope,
      requestId: "batch-action",
      sourceRequestId: "conflicted-batch",
      expectedRevision: snapshot.revision,
      confirmNativeStopped: false,
      confirmDiscard: abort,
    };
    assert.equal(
      (await (abort ? f.service.abortIntegration(action) : f.service.continueIntegration(action)))
        .status,
      "success",
    );
    assert.equal((await f.git("rev-list", "--count", `${base}..HEAD`)).trim(), abort ? "0" : "2");
  });
test("Merge 必须显式主线，选定 parent 的摘取可执行", async (t) => {
  const f = await historyFixture(t),
    base = (await f.git("rev-parse", "HEAD")).trim();
  await f.git("checkout", "-qb", "topic");
  await writeFile(join(f.root, "topic.txt"), "topic");
  await f.git("add", ".");
  await f.git("commit", "-qm", "topic");
  await f.git("checkout", "-q", "main");
  await f.git("merge", "--no-ff", "--no-edit", "topic");
  const merge = (await f.git("rev-parse", "HEAD")).trim();
  await f.git("checkout", "-qb", "destination", base);
  await assert.rejects(
    f.service.previewIntegration({ ...f.scope, mode: "cherry-pick", targetRef: merge }),
    /mainline-required/,
  );
  const preview = await f.service.previewIntegration({
    ...f.scope,
    mode: "cherry-pick",
    targetRef: merge,
    mainline: 1,
  });
  assert.equal(
    (await f.service.startIntegration({ ...f.scope, requestId: "mainline-pick", preview })).status,
    "success",
  );
  assert.match(await f.git("show", "HEAD:topic.txt"), /topic/);
});
test("批次暂停后改写 sequencer todo 不可继续", async (t) => {
  const f = await historyFixture(t);
  await f.git("checkout", "-qb", "topic");
  const targets: string[] = [];
  for (const value of ["topic one\n", "topic two\n"]) {
    await writeFile(join(f.root, "a.txt"), value);
    await f.git("commit", "-qam", value);
    targets.push((await f.git("rev-parse", "HEAD")).trim());
  }
  await f.git("checkout", "-q", "main");
  await writeFile(join(f.root, "a.txt"), "main\n");
  await f.git("commit", "-qam", "main");
  const preview = await f.service.previewIntegration({
    ...f.scope,
    mode: "cherry-pick",
    targetRef: targets[0]!,
    targets,
  });
  assert.equal(
    (await f.service.startIntegration({ ...f.scope, requestId: "tamper", preview })).status,
    "conflict",
  );
  await writeFile(
    join(f.root, ".git", "sequencer", "todo"),
    `exec echo forbidden\npick ${targets[1]} two\n`,
  );
  const snapshot = await f.service.getIntegrationSnapshot(f.scope);
  assert.equal(snapshot.canContinue, false);
  assert.equal(snapshot.canAbort, false);
});
