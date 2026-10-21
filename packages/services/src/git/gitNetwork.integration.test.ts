import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { publishFixture } from "./gitPublishTestHelpers.js";
import { createGitService } from "./gitService.js";
import { createGitCommandProvider } from "./providers/gitCommandProvider.js";
import { getGitCommandEnv } from "./config.js";

async function fixture(t: TestContext, wrap?: Parameters<typeof publishFixture>[1]) {
  const f = await publishFixture(t, wrap);
  const remote = await f.remote("origin");
  await f.git("push", "-qu", "origin", "main");
  const peer = join(f.base, "peer");
  await f.at(f.base, "clone", "-q", "-b", "main", remote.path, peer);
  await f.at(peer, "config", "user.name", "Fixture");
  await f.at(peer, "config", "user.email", "fixture@example.invalid");
  const advance = async () => {
    await writeFile(join(peer, "a.txt"), "upstream\n");
    await f.at(peer, "add", "a.txt");
    await f.at(peer, "commit", "-qm", "advance");
    await f.at(peer, "tag", "not-fetched");
    await f.at(peer, "push", "-q", "origin", "main", "--tags");
    return (await f.at(peer, "rev-parse", "HEAD")).trim();
  };
  const snapshot = () => f.service.getNetworkSnapshot(f.request);
  const request = async (requestId: string) => ({
    ...f.request,
    requestId,
    expectedRevision: (await snapshot()).revision,
  });
  const fetch = async (id = "fetch") =>
    f.service.fetchRemotes({ ...(await request(id)), remotes: ["origin"] });
  return { ...f, origin: remote, peer, advance, snapshot, mutation: request, fetch };
}

test("Fetch 只更新选中远端跟踪引用，dirty/index/HEAD/FETCH_HEAD/tags 不变且不 prune", async (t) => {
  const f = await fixture(t);
  const oldHead = (await f.git("rev-parse", "HEAD")).trim();
  await f.git("update-ref", "refs/remotes/origin/stale", oldHead);
  await f.git("config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*");
  await f.git("config", "fetch.pruneTags", "true");
  await f.git("config", "remote.origin.prune", "true");
  await writeFile(join(f.root, "a.txt"), "staged\n");
  await f.git("add", "a.txt");
  await writeFile(join(f.root, "a.txt"), "dirty\n");
  const before = await f.state();
  const index = await readFile(join(f.root, ".git", "index"));
  const target = await f.advance();
  assert.equal((await f.snapshot()).behind, 0, "local refresh never fetches");
  const result = await f.fetch();
  assert.equal(result.status, "success");
  assert.equal((await f.git("rev-parse", "origin/main")).trim(), target);
  assert.deepEqual(await f.state(), before);
  assert.deepEqual(await readFile(join(f.root, ".git", "index")), index);
  assert.equal((await f.git("rev-parse", "origin/stale")).trim(), oldHead);
  assert.equal((await f.git("tag", "--list")).trim(), "");
  await assert.rejects(readFile(join(f.root, ".git", "FETCH_HEAD")), { code: "ENOENT" });
  await f.git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  assert.equal((await f.snapshot()).behind, 1);
});

test("远端 URL 修改使已生成的发布确认失效，不能推送到新地址", async (t) => {
  const f = await fixture(t);
  const expectedState = await f.state();
  await f.git("config", "remote.origin.pushurl", "https://example.invalid/new-destination");
  await assert.rejects(
    f.service.push({ ...f.request, remote: "origin", branch: "main", expectedState }),
    /变化/,
  );
});

test("快进不覆盖忽略文件，保留本地字节与 HEAD", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, ".git", "info", "exclude"), "private.txt\n");
  await writeFile(join(f.root, "private.txt"), "local-private\n");
  await writeFile(join(f.peer, "private.txt"), "server-file\n");
  await f.at(f.peer, "add", "private.txt");
  await f.at(f.peer, "commit", "-qm", "new-file");
  await f.at(f.peer, "push", "-q", "origin", "main");
  await f.fetch();
  const preview = await f.service.previewFastForward(f.request);
  assert.equal(preview.reason, "ready");
  const result = await f.service.fastForward({
    ...f.request,
    requestId: "ignored-collision",
    expectedRevision: preview.revision,
    preview,
  });
  assert.equal(result.status, "failed");
  assert.equal((await f.git("rev-parse", "HEAD")).trim(), preview.head);
  assert.equal(await readFile(join(f.root, "private.txt"), "utf8"), "local-private\n");
});

test("多远端 Fetch 部分失败逐项结算，重复 requestId 不重执行，不同参数拒绝", async (t) => {
  const f = await fixture(t);
  await f.git("remote", "add", "broken", join(f.base, "missing.git"));
  await f.advance();
  const params = { ...(await f.mutation("partial")), remotes: ["origin", "broken"] };
  const result = await f.service.fetchRemotes(params);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.results, [
    { remote: "origin", status: "success" },
    { remote: "broken", status: "failed" },
  ]);
  await f.git("remote", "remove", "origin");
  assert.deepEqual(await f.service.fetchRemotes(params), result);
  await assert.rejects(f.service.fetchRemotes({ ...params, remotes: ["broken"] }), /requestId/);
  assert.deepEqual(
    await f.service.getNetworkOperation({ ...f.request, requestId: "partial" }),
    result,
  );
});

test("远端 URL 分离、多值编辑、重命名、删除与陈旧 revision", async (t) => {
  const f = await fixture(t);
  const original = await f.mutation("stale");
  for (const [id, action, extra] of [
    [
      "add",
      "add",
      {
        name: "backup",
        fetchUrls: ["https://example.invalid/a", "https://example.invalid/b"],
        pushUrls: ["ssh://example.invalid/push"],
      },
    ],
    [
      "edit",
      "edit",
      { name: "backup", fetchUrls: ["https://example.invalid/edited"], pushUrls: [] },
    ],
    ["rename", "rename", { name: "backup", newName: "mirror" }],
    ["remove", "remove", { name: "mirror" }],
  ] as const) {
    const params = { ...(await f.mutation(id)), action, ...extra };
    assert.equal(
      (await f.service.mutateRemote(params as Parameters<typeof f.service.mutateRemote>[0])).status,
      "success",
    );
    if (id === "add")
      assert.deepEqual(
        (await f.snapshot()).remotes.find((item) => item.name === "backup"),
        { name: "backup", fetchUrls: [...extra.fetchUrls], pushUrls: [...extra.pushUrls] },
      );
    if (id === "edit")
      assert.deepEqual(
        (await f.snapshot()).remotes.find((item) => item.name === "backup")?.pushUrls,
        [],
      );
  }
  assert.deepEqual(
    (await f.snapshot()).remotes.map((item) => item.name),
    ["origin"],
  );
  await f.git("config", "remote.origin.pushurl", "https://example.invalid/push");
  assert.equal(
    (await f.service.mutateRemote({ ...original, action: "remove", name: "origin" })).code,
    "stale-preview",
  );
  assert.equal((await f.snapshot()).remotes.length, 1);
});

test("跟踪设置与取消精确匹配远端分支，缺失分支和陈旧配置拒绝", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.service.setBranchTracking({
        ...(await f.mutation("unset")),
        branch: "main",
        upstream: null,
      })
    ).status,
    "success",
  );
  assert.equal((await f.snapshot()).upstream, null);
  assert.equal(
    (
      await f.service.setBranchTracking({
        ...(await f.mutation("set")),
        branch: "main",
        upstream: { remote: "origin", branch: "main" },
      })
    ).status,
    "success",
  );
  assert.equal((await f.snapshot()).upstream, "origin/main");
  assert.equal(
    (
      await f.service.setBranchTracking({
        ...(await f.mutation("missing")),
        branch: "main",
        upstream: { remote: "origin", branch: "absent" },
      })
    ).code,
    "missing-upstream",
  );
});

test("快进预览与执行使用固定 OID，成功且不产生 merge commit、不运行 hook", async (t) => {
  const f = await fixture(t);
  const target = await f.advance();
  await f.fetch();
  await f.hook("post-merge", "echo bad > hook-ran.txt");
  const preview = await f.service.previewFastForward(f.request);
  assert.equal(preview.reason, "ready");
  assert.equal(preview.target, target);
  const params = { ...f.request, requestId: "ff", expectedRevision: preview.revision, preview };
  const result = await f.service.fastForward(params);
  assert.equal(result.status, "success");
  assert.equal(result.after, target);
  assert.equal((await f.git("rev-parse", "HEAD")).trim(), target);
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "upstream\n");
  await assert.rejects(readFile(join(f.root, "hook-ran.txt")), { code: "ENOENT" });
  assert.deepEqual(await f.service.fastForward(params), result);
  assert.equal((await f.service.previewFastForward(f.request)).reason, "up-to-date");
});

for (const change of ["file", "config", "ref", "head"] as const) {
  test(`快进旧预览拒绝 ${change} 变化，不改变工作树`, async (t) => {
    const f = await fixture(t);
    await f.advance();
    await f.fetch();
    const preview = await f.service.previewFastForward(f.request);
    if (change === "file") await writeFile(join(f.root, "new.txt"), "keep\n");
    if (change === "config")
      await f.git("config", "remote.origin.pushurl", "https://example.invalid/changed");
    if (change === "ref") await f.git("update-ref", "refs/remotes/origin/main", preview.head!);
    if (change === "head") {
      await f.git("switch", "-qc", "other");
    }
    const before = await f.state();
    const result = await f.service.fastForward({
      ...f.request,
      requestId: "stale",
      expectedRevision: preview.revision,
      preview,
    });
    assert.equal(result.status, "failed");
    assert.deepEqual(await f.state(), before);
  });
}

for (const reason of [
  "dirty",
  "detached",
  "no-upstream",
  "missing-upstream",
  "diverged",
  "operation-in-progress",
] as const) {
  test(`快进明确阻塞 ${reason}`, async (t) => {
    const f = await fixture(t);
    await f.advance();
    await f.fetch();
    if (reason === "dirty") await writeFile(join(f.root, "new.txt"), "dirty\n");
    if (reason === "detached") await f.git("switch", "--detach");
    if (reason === "no-upstream") await f.git("branch", "--unset-upstream");
    if (reason === "missing-upstream") await f.git("update-ref", "-d", "refs/remotes/origin/main");
    if (reason === "diverged") {
      await writeFile(join(f.root, "b.txt"), "local\n");
      await f.git("commit", "-qam", "local");
    }
    if (reason === "operation-in-progress")
      await writeFile(join(f.root, ".git", "MERGE_HEAD"), `${(await f.snapshot()).head}\n`);
    assert.equal((await f.service.previewFastForward(f.request)).reason, reason);
  });
}

test("收据跨 Host 重启恢复且无 URL，running 不重放", async (t) => {
  const f = await fixture(t);
  const dataDir = join(f.base, "receipts");
  await mkdir(dataDir);
  const provider = createGitCommandProvider({
    environmentProvider: {
      resolveGitBinary: async () => "git",
      createCommandEnv: () => ({
        ...getGitCommandEnv(),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: f.globalConfig,
      }),
    },
  });
  const first = createGitService({ commandProvider: provider, reviewStateDataDir: dataDir });
  const second = createGitService({ commandProvider: provider, reviewStateDataDir: dataDir });
  const params = { ...(await f.mutation("durable")), remotes: ["origin"] };
  const result = await first.fetchRemotes(params);
  await f.git("remote", "remove", "origin");
  assert.deepEqual(await second.fetchRemotes(params), result);
  assert.deepEqual(
    await second.getNetworkOperation({ ...f.request, requestId: "durable" }),
    result,
  );
});

test("严格协议拒绝任意 URL Fetch、refspec/选项与资源注入", async (t) => {
  const f = await fixture(t);
  for (const remote of ["--all", "https://example.invalid/a", "origin:refs/heads/main", "a/b"]) {
    await assert.rejects(
      f.service.fetchRemotes({ ...(await f.mutation("bad")), remotes: [remote] }),
    );
  }
  await assert.rejects(
    f.service.fetchRemotes({
      ...(await f.mutation("injection")),
      remotes: ["origin"],
      resource: "checkout",
    } as never),
  );
});

for (const flag of ["timedOut", "outputTruncated", "orphaned"] as const) {
  test(`Fetch ${flag} 返回 unknown，原请求不重放已生效的引用更新`, async (t) => {
    let calls = 0;
    const f = await fixture(t, (provider) => ({
      ...provider,
      run: async (params) => {
        const result = await provider.run(params);
        if (params.args.includes("fetch")) {
          calls++;
          return { ...result, [flag]: true };
        }
        return result;
      },
    }));
    const target = await f.advance();
    const params = { ...(await f.mutation(`fault-${flag}`)), remotes: ["origin"] };
    const result = await f.service.fetchRemotes(params);
    assert.equal(result.status, "unknown");
    assert.equal((await f.git("rev-parse", "origin/main")).trim(), target);
    assert.deepEqual(await f.service.fetchRemotes(params), result);
    assert.equal(calls, 1);
    if (flag === "orphaned") assert.equal(result.unsettled, true);
  });
}

test("快进已经生效而刷新失败保留 unknown，不能报告未执行或重复更新", async (t) => {
  let updated = false;
  const f = await fixture(t, (provider) => ({
    ...provider,
    run: async (params) => {
      if (updated && params.args[0] === "for-each-ref") throw new Error("fixture-read-failure");
      const result = await provider.run(params);
      if (params.args.includes("merge") && params.args.includes("--ff-only")) updated = true;
      return result;
    },
  }));
  const target = await f.advance();
  await f.fetch();
  const preview = await f.service.previewFastForward(f.request);
  const params = {
    ...f.request,
    requestId: "ff-post-read",
    expectedRevision: preview.revision,
    preview,
  };
  const result = await f.service.fastForward(params);
  assert.equal(result.status, "unknown");
  assert.equal((await f.git("rev-parse", "HEAD")).trim(), target);
  assert.deepEqual(await f.service.fastForward(params), result);
});

test("unborn 分支给出明确预览原因", async (t) => {
  const f = await fixture(t);
  const root = join(f.base, "empty");
  await mkdir(root);
  await f.at(root, "init", "-qb", "empty");
  assert.equal((await f.service.previewFastForward({ workspacePath: root })).reason, "unborn");
});

test("assume-unchanged 隐藏修改不能获取快进许可", async (t) => {
  const f = await fixture(t);
  await f.advance();
  await f.fetch();
  await f.git("update-index", "--assume-unchanged", "a.txt");
  await writeFile(join(f.root, "a.txt"), "hidden-local\n");
  assert.equal((await f.service.previewFastForward(f.request)).reason, "unsupported");
});

test("多远端 Fetch 中外部配置变化停止后续网络命令，已成功项保留", async (t) => {
  let change: (() => Promise<void>) | undefined;
  let calls = 0;
  const f = await fixture(t, (provider) => ({
    ...provider,
    run: async (params) => {
      const result = await provider.run(params);
      if (params.args.includes("fetch")) {
        calls++;
        await change?.();
      }
      return result;
    },
  }));
  await f.remote("backup");
  change = async () => {
    await f.git("config", "remote.backup.url", "https://example.invalid/unconfirmed");
  };
  const result = await f.service.fetchRemotes({
    ...(await f.mutation("config-changed-during-fetch")),
    remotes: ["origin", "backup"],
  });
  assert.equal(result.status, "partial");
  assert.equal(result.code, "stale-preview");
  assert.deepEqual(result.results, [
    { remote: "origin", status: "success" },
    { remote: "backup", status: "failed" },
  ]);
  assert.equal(calls, 1);
});

test("Fetch 接收远端新分支与强制更新，仅改对应跟踪引用", async (t) => {
  const f = await fixture(t);
  const before = await f.state();
  const advanced = await f.advance();
  await f.fetch("before-force");
  assert.equal((await f.git("rev-parse", "origin/main")).trim(), advanced);
  await f.origin.git("update-ref", "refs/heads/main", before.headCommitHash!);
  await f.origin.git("update-ref", "refs/heads/new-topic", advanced);
  assert.equal((await f.fetch("after-force")).status, "success");
  assert.equal((await f.git("rev-parse", "origin/main")).trim(), before.headCommitHash);
  assert.equal((await f.git("rev-parse", "origin/new-topic")).trim(), advanced);
  assert.deepEqual(await f.state(), before);
});
