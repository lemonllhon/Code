import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { historyFixture } from "./gitHistoryTestHelpers.js";

test("候选使用完整 ref、作者去重且只读，不泄漏内部 checkpoint", async (t) => {
  const f = await historyFixture(t);
  await f.git("branch", "feature/中文");
  await f.git("tag", "v1");
  await f.git("update-ref", "refs/remotes/origin/main", "HEAD");
  await f.git("checkout", "-qb", "temporary");
  await writeFile(join(f.root, "a.txt"), "hidden\n");
  await f.git(
    "-c",
    "user.name=内部作者",
    "-c",
    "user.email=hidden@example.invalid",
    "commit",
    "-qam",
    "checkpoint",
  );
  await f.git("update-ref", "refs/lcode/checkpoints/hidden", "HEAD");
  await f.git("checkout", "-q", "main");
  await f.git("branch", "-D", "temporary");
  const index = await readFile(join(f.root, ".git", "index"));
  const before = await f.git("show-ref");
  const candidates = await f.service.getHistoryCandidates(f.scope);
  assert.ok(candidates.refs.some((r) => r.value === "refs/heads/feature/中文"));
  assert.ok(candidates.refs.some((r) => r.value === "refs/remotes/origin/main"));
  assert.ok(candidates.refs.some((r) => r.value === "refs/tags/v1"));
  assert.equal(candidates.authors.length, 1);
  assert.ok(!candidates.authors.some((a) => a.name === "内部作者"));
  assert.equal(await f.git("show-ref"), before);
  assert.ok(index.equals(await readFile(join(f.root, ".git", "index"))));
  await assert.rejects(f.service.getHistoryCandidates({ ...f.scope, extra: true } as any));
});
test("候选 Ref 返回有界并明确截断", async (t) => {
  const f = await historyFixture(t),
    head = (await f.git("rev-parse", "HEAD")).trim();
  const result = await f.command.run({
    cwd: f.root,
    args: ["update-ref", "--stdin"],
    stdin:
      Array.from(
        { length: 501 },
        (_, index) => `create refs/heads/candidate-${index} ${head}`,
      ).join("\n") + "\n",
  });
  assert.equal(result.exitCode, 0);
  const candidates = await f.service.getHistoryCandidates(f.scope);
  assert.equal(candidates.refs.length, 500);
  assert.equal(candidates.refsTruncated, true);
});
