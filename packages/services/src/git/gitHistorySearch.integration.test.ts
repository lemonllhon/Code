import assert from "node:assert/strict";
import test from "node:test";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { historyFixture } from "./gitHistoryTestHelpers.js";
test("搜索字面/ERE/大小写与正文，Hash 和定位只读，作者仍按字面", async (t) => {
  const f = await historyFixture(t);
  await writeFile(join(f.root, "a.txt"), "search\n");
  await f.git("commit", "-qam", "Case [literal]\n\nbody NEEDLE");
  const head = (await f.git("rev-parse", "HEAD")).trim();
  const index = await readFile(join(f.root, ".git", "index"));
  assert.equal(
    (await f.service.getHistory({ ...f.scope, search: "needle" })).commits[0]?.hash,
    head,
  );
  assert.equal(
    (await f.service.getHistory({ ...f.scope, search: "needle", caseSensitive: true })).commits
      .length,
    0,
  );
  assert.equal(
    (await f.service.getHistory({ ...f.scope, search: "Case.*literal", searchMode: "regex" }))
      .commits[0]?.hash,
    head,
  );
  assert.equal(
    (await f.service.getHistory({ ...f.scope, search: "Case.*literal" })).commits.length,
    0,
  );
  assert.equal(
    (await f.service.getHistory({ ...f.scope, search: head.slice(0, 8) })).commits[0]?.hash,
    head,
  );
  assert.equal(
    (
      await f.service.getHistory({
        ...f.scope,
        search: "NEEDLE",
        searchMode: "regex",
        author: "Fixt.*",
      })
    ).commits.length,
    0,
  );
  await assert.rejects(
    f.service.getHistory({ ...f.scope, search: "[", searchMode: "regex" }),
    /invalid-history-regex/,
  );
  await assert.rejects(
    f.service.getHistory({ ...f.scope, search: "[z-a]", searchMode: "regex" }),
    /invalid-history-regex/,
  );
  assert.equal(
    (await f.service.locateHistoryCommit({ ...f.scope, target: head.slice(0, 8) })).hash,
    head,
  );
  assert.equal(
    (await f.service.locateHistoryCommit({ ...f.scope, target: "refs/heads/main" })).hash,
    head,
  );
  await assert.rejects(f.service.locateHistoryCommit({ ...f.scope, target: "HEAD~1" }));
  assert.ok(index.equals(await readFile(join(f.root, ".git", "index"))));
  await f.git("checkout", "-qb", "private");
  await writeFile(join(f.root, "a.txt"), "hidden\n");
  await f.git("commit", "-qam", "private checkpoint");
  const hidden = (await f.git("rev-parse", "HEAD")).trim();
  await f.git("update-ref", "refs/lcode/checkpoints/private", hidden);
  await f.git("checkout", "-q", "main");
  await f.git("branch", "-D", "private");
  assert.equal((await f.service.getHistory({ ...f.scope, search: hidden })).commits.length, 0);
  await assert.rejects(
    f.service.locateHistoryCommit({ ...f.scope, target: hidden }),
    /missing-history-target/,
  );
});
test("正则查询的原生超时仍报告读取失败", async (t) => {
  const f = await historyFixture(t, (command) => ({
    ...command,
    run: async (params) => {
      const result = await command.run(params);
      return params.args.includes("log") && params.args.some((arg) => arg.startsWith("--grep="))
        ? { ...result, timedOut: true }
        : result;
    },
  }));
  await assert.rejects(
    f.service.getHistory({ ...f.scope, search: "initial", searchMode: "regex" }),
    /history-read-failed/,
  );
});
