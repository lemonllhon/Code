import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { historyFixture } from "./gitHistoryTestHelpers.js";

test("历史字面筛选与 refs 绑定分页、隐藏 refs 排除；详情及文件 Diff 为真实 parent 内容", async (t) => {
  const f = await historyFixture(t),
    root = (await f.git("rev-parse", "HEAD")).trim();
  await writeFile(join(f.root, "中文 [file].txt"), "hello\n");
  await f.git("add", ".");
  await f.git("commit", "-qm", "[literal] --all\n\n完整中文消息");
  const page = await f.service.getHistory({ ...f.scope, search: "[literal]", limit: 1 });
  assert.equal(page.commits.length, 1);
  const hash = page.commits[0]!.hash;
  assert.ok(page.commits[0]!.refs.some((ref) => ref.kind === "head" && ref.name === "HEAD"));
  assert.equal((await f.service.getHistory({ ...f.scope, search: "[missing]" })).commits.length, 0);
  const more = await f.service.getHistory({ ...f.scope, author: "Fixture", limit: 1 });
  assert.ok(more.hasMore);
  assert.equal(
    (
      await f.service.getHistory({
        ...f.scope,
        author: "Fixture",
        skip: 1,
        limit: 1,
        expectedRevision: more.revision,
      })
    ).commits[0]!.hash,
    root,
  );
  const detail = await f.service.getHistoryDetail({ ...f.scope, hash });
  assert.match(detail.message, /完整中文/);
  assert.equal(detail.parentHash, root);
  const file = await f.service.getHistoryFile({ ...f.scope, hash, path: "中文 [file].txt" });
  assert.equal(file.before.kind, "absent");
  assert.equal(file.after.text, "hello\n");
  const rootDetail = await f.service.getHistoryDetail({ ...f.scope, hash: root });
  assert.equal(rootDetail.parentHash, null);
  assert.equal(rootDetail.files.length, 2);
  const index = await readFile(join(f.root, ".git", "index"));
  await f.service.getHistoryFile({ ...f.scope, hash: root, path: "a.txt" });
  assert.ok(index.equals(await readFile(join(f.root, ".git", "index"))));
  await f.git("branch", "moved");
  await assert.rejects(
    f.service.getHistory({
      ...f.scope,
      author: "Fixture",
      skip: 1,
      expectedRevision: more.revision,
    }),
    /stale-history/,
  );
  await f.git("checkout", "-qb", "temporary");
  await writeFile(join(f.root, "a.txt"), "hidden\n");
  await f.git("commit", "-qam", "hidden checkpoint only");
  const hidden = (await f.git("rev-parse", "HEAD")).trim();
  await f.git("update-ref", "refs/lcode/checkpoints/hidden", hidden);
  await f.git("checkout", "-q", "main");
  await f.git("branch", "-D", "temporary");
  assert.ok(!(await f.service.getHistory(f.scope)).commits.some((item) => item.hash === hidden));
});

test("Merge parent 选择、二进制与删除文件分流，越界 parent/path 拒绝", async (t) => {
  const f = await historyFixture(t);
  await f.git("checkout", "-qb", "topic");
  await writeFile(join(f.root, "binary.bin"), Buffer.from([0, 1, 255]));
  await f.git("add", ".");
  await f.git("commit", "-qm", "binary");
  await f.git("checkout", "-q", "main");
  await f.git("rm", "a.txt");
  await f.git("commit", "-qm", "remove");
  await f.git("merge", "--no-ff", "--no-edit", "topic");
  const hash = (await f.git("rev-parse", "HEAD")).trim(),
    one = await f.service.getHistoryDetail({ ...f.scope, hash }),
    two = await f.service.getHistoryDetail({ ...f.scope, hash, parent: 2 });
  assert.equal(one.parents.length, 2);
  assert.notEqual(one.parentHash, two.parentHash);
  assert.equal(one.files[0]!.path, "binary.bin");
  assert.equal(two.files[0]!.path, "a.txt");
  assert.equal(
    (await f.service.getHistoryFile({ ...f.scope, hash, path: "binary.bin" })).after.kind,
    "binary",
  );
  assert.equal(
    (await f.service.getHistoryFile({ ...f.scope, hash, parent: 2, path: "a.txt" })).after.kind,
    "absent",
  );
  await assert.rejects(
    f.service.getHistoryDetail({ ...f.scope, hash, parent: 3 }),
    /invalid-parent/,
  );
  await assert.rejects(f.service.getHistoryFile({ ...f.scope, hash, path: "../outside" }));
});
