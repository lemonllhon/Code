import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitNetworkJournal } from "./gitNetworkJournal.js";

test("并发请求只有一个执行者，未知/失败结果均不重试，参数绑定及 identity 隔离", async () => {
  const journal = new GitNetworkJournal();
  const params = { workspacePath: "/repo", workspaceIdentity: "remote:a", requestId: "one" };
  let calls = 0,
    release!: () => void,
    started!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const run = () =>
    journal.run("fetch", params, async () => {
      calls++;
      started();
      await barrier;
      return { status: "unknown" };
    });
  const first = run();
  await entered;
  assert.equal((await run()).status, "running");
  release();
  const result = await first;
  assert.equal(result.status, "unknown");
  assert.deepEqual(await run(), result);
  assert.equal(calls, 1);
  await assert.rejects(
    journal.run("remote", params, async () => ({ status: "success" })),
    /requestId/,
  );
  assert.equal(await journal.get({ ...params, workspaceIdentity: "remote:b" }), null);
});

test("跨 Host/重启 running 返回 unknown，收据内容不落盘原始参数/URL", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "lcode-network-journal-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const first = new GitNetworkJournal(dataDir),
    second = new GitNetworkJournal(dataDir);
  const params = {
    workspacePath: "/repo",
    requestId: "durable",
    fetchUrls: ["https://secret@example.invalid/private"],
  };
  let release!: () => void, started!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const running = first.run("remote", params, async (checkpoint) => {
    await checkpoint({ results: [{ remote: "origin", status: "success" }] });
    started();
    await barrier;
    return { status: "success" };
  });
  await entered;
  const recovered = await second.run("remote", params, async () => assert.fail("must not replay"));
  assert.equal(recovered.status, "unknown");
  assert.deepEqual(recovered.results, [{ remote: "origin", status: "success" }]);
  const directory = join(dataDir, "network-operations");
  const content = await readFile(
    join(directory, (await readdir(directory)).find((name) => name.endsWith(".json"))!),
    "utf8",
  );
  assert.doesNotMatch(content, /secret|example\.invalid|fetchUrls/);
  release();
  assert.deepEqual(await running, await second.get(params));
});

test("后续步骤异常保留已有成功收据，整体仍为部分成功", async () => {
  const journal = new GitNetworkJournal();
  const result = await journal.run(
    "fetch",
    { workspacePath: "/repo", requestId: "partial-exception" },
    async (checkpoint) => {
      await checkpoint({ results: [{ remote: "origin", status: "success" }] });
      throw new Error("fixture-read-failed");
    },
  );
  assert.equal(result.status, "partial");
  assert.deepEqual(result.results, [{ remote: "origin", status: "success" }]);
});
