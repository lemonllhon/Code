import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { publishFixture } from "./gitPublishTestHelpers.js";

type Fixture = Awaited<ReturnType<typeof publishFixture>>;
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const indexBytes = (f: Fixture) => readFile(join(f.root, ".git", "index"));
async function expireStat(f: Fixture) {
  // 先使 stat 缓存过期，再接受快照；整个实验不改变文件内容。
  await utimes(join(f.root, "b.txt"), new Date(0), new Date(0));
}
async function externalStatus(f: Fixture) {
  const result = await f.command.run({
    cwd: f.root,
    args: ["status", "--porcelain"],
    env: { GIT_OPTIONAL_LOCKS: "1" },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "");
}

test("accepted publication survives stat-only refresh before the next write", async (t) => {
  for (const command of ["status", "update-index"])
    await t.test(command, async (t) => {
      const f = await publishFixture(t);
      await expireStat(f);
      const expectedState = await f.state();
      const before = await indexBytes(f);
      const entries = await f.git("ls-files", "--stage", "-v", "-z");
      if (command === "status") await externalStatus(f);
      else await f.git("update-index", "--refresh");
      assert.notEqual(hash(await indexBytes(f)), hash(before), "real index bytes must refresh");
      assert.equal(await f.git("ls-files", "--stage", "-v", "-z"), entries);
      assert.deepEqual(await f.state(), expectedState);
      const tag = await f.service.createTag({
        ...f.request,
        name: "after-inspection",
        expectedState,
      });
      assert.equal(tag.commitHash, expectedState.headCommitHash);
    });
});

test("publication sampling ignores cache refresh but rejects real changes at the same command barrier", async (t) => {
  for (const change of ["cache", "staged"])
    await t.test(change, async (t) => {
      let armed = false;
      let reads = 0;
      let injected = false;
      const f = await publishFixture(t, (command) => ({
        ...command,
        run: async (params) => {
          const result = await command.run(params);
          if (
            armed &&
            params.args[0] === "ls-files" &&
            params.args.includes("--stage") &&
            ++reads === 2
          ) {
            injected = true;
            if (change === "cache") {
              const status = await command.run({
                cwd: params.cwd,
                args: ["status", "--porcelain"],
                env: { GIT_OPTIONAL_LOCKS: "1" },
              });
              assert.equal(status.exitCode, 0);
            } else {
              await writeFile(join(params.cwd, "b.txt"), "external staged\n");
              await command.run({ cwd: params.cwd, args: ["add", "b.txt"] });
            }
          }
          return result;
        },
      }));
      await expireStat(f);
      const expected = await f.state();
      armed = true;
      if (change === "cache") assert.deepEqual(await f.state(), expected);
      else await assert.rejects(f.state(), /变化|changed/);
      assert.equal(injected, true);
    });
});

test("ordinary and reviewed publication continue through branch and Tag after concurrent status", async (t) => {
  for (const reviewed of [false, true])
    await t.test(reviewed ? "reviewed" : "ordinary", async (t) => {
      let armed = false;
      let injected = false;
      let f: Fixture;
      f = await publishFixture(t, (command) => ({
        ...command,
        run: async (params) => {
          const result = await command.run(params);
          // push 已实际完成，返回调用方后还会执行原后置校验；不靠 sleep 猜时序。
          if (armed && params.args.includes("push")) {
            armed = false;
            injected = true;
            const before = await indexBytes(f);
            await externalStatus(f);
            assert.notEqual(hash(await indexBytes(f)), hash(before));
          }
          return result;
        },
      }));
      const remote = await f.remote("origin");
      await writeFile(join(f.root, "a.txt"), "next\n");
      const draft = reviewed
        ? await f.service.generateCommitMessage({ ...f.request, review: true })
        : undefined;
      const committed = await f.service.commit({
        ...f.request,
        message: "test: inspection during publication",
        paths: [join(f.root, "a.txt")],
        expectedState: await f.state(),
        ...(draft?.review
          ? {
              review: {
                id: draft.review.id,
                groupId: draft.review.groups[0]!.id,
                acknowledged: true,
              },
            }
          : {}),
      });
      assert.ok(committed.publishState, committed.warning);
      await expireStat(f);
      const expectedState = await f.state();
      armed = true;
      const pushed = await f.service.push({
        ...f.request,
        remote: "origin",
        branch: "main",
        expectedState,
      });
      assert.equal(injected, true);
      assert.equal(pushed.warning, undefined);
      await f.service.createTag({ ...f.request, name: "publication", expectedState });
      const tagPush = await f.service.push({
        ...f.request,
        remote: "origin",
        tag: "publication",
        tagCommitHash: committed.commitHash,
        expectedState,
      });
      assert.equal(tagPush.warning, undefined);
      assert.equal((await remote.git("rev-parse", "main")).trim(), committed.commitHash);
      assert.equal(
        (await remote.git("rev-parse", "refs/tags/publication")).trim(),
        committed.commitHash,
      );
      assert.equal((await f.git("rev-list", "--count", "HEAD")).trim(), "2");
    });
});

test("persistent index flags and hidden worktree changes still invalidate confirmation", async (t) => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"])
    await t.test(flag, async (t) => {
      const f = await publishFixture(t);
      const before = await f.state();
      await f.git("update-index", flag, "b.txt");
      const flagged = await f.state();
      assert.notEqual(flagged.indexFingerprint, before.indexFingerprint);
      await assert.rejects(
        f.service.createTag({ ...f.request, name: "stale", expectedState: before }),
        /变化/,
      );
      await writeFile(join(f.root, "b.txt"), "hidden external bytes\n");
      assert.notEqual((await f.state()).worktreeFingerprint, flagged.worktreeFingerprint);
      await assert.rejects(
        f.service.createTag({ ...f.request, name: "hidden", expectedState: flagged }),
        /变化/,
      );
      assert.deepEqual((await f.service.listTags(f.request)).tags, []);
    });
  await t.test(
    "intent-to-add empty file has the same listed OID but different approval",
    async (t) => {
      const f = await publishFixture(t);
      await writeFile(join(f.root, "empty.txt"), "");
      await f.git("add", "-N", "empty.txt");
      const expectedState = await f.state();
      const listed = await f.git("ls-files", "--stage", "-v", "-z");
      await f.git("add", "empty.txt");
      assert.equal(await f.git("ls-files", "--stage", "-v", "-z"), listed);
      assert.notEqual((await f.state()).indexFingerprint, expectedState.indexFingerprint);
      await assert.rejects(
        f.service.createTag({ ...f.request, name: "intent-stale", expectedState }),
        /变化/,
      );
    },
  );
});

test("Git index storage representation is not a second publication truth", async (t) => {
  for (const version of [2, 3, 4])
    await t.test(`version ${version}`, async (t) => {
      const f = await publishFixture(t);
      if (version === 3) await f.git("update-index", "--skip-worktree", "b.txt");
      await f.git("update-index", "--index-version", "4");
      const expected = await f.state();
      await f.git("update-index", "--index-version", String(version));
      assert.equal((await indexBytes(f)).readUInt32BE(4), version);
      assert.deepEqual(await f.state(), expected);
    });
  await t.test("split index", async (t) => {
    const f = await publishFixture(t);
    const expected = await f.state();
    await f.git("update-index", "--split-index");
    assert.deepEqual(await f.state(), expected);
    await f.git("update-index", "--no-split-index");
    assert.deepEqual(await f.state(), expected);
  });
  await t.test("sparse and full index preserve the same sparse checkout approval", async (t) => {
    const f = await publishFixture(t);
    await mkdir(join(f.root, "keep"));
    await mkdir(join(f.root, "omit"));
    await writeFile(join(f.root, "keep", "a.txt"), "kept\n");
    await writeFile(join(f.root, "omit", "b.txt"), "sparse\n");
    await f.git("add", ".");
    await f.git("commit", "-qm", "sparse fixture");
    await f.git("sparse-checkout", "init", "--cone", "--sparse-index");
    await f.git("sparse-checkout", "set", "keep");
    const expected = await f.state();
    await f.git("sparse-checkout", "reapply", "--no-sparse-index");
    assert.deepEqual(await f.state(), expected);
  });
  await t.test("absent and empty unborn index", async (t) => {
    const f = await publishFixture(t);
    const root = join(f.base, "unborn");
    await mkdir(root);
    await f.at(root, "init", "-q", "-b", "main");
    const request = { ...f.request, workspacePath: root };
    const expected = await f.service.getPublishState(request);
    assert.equal(expected.headCommitHash, null);
    await f.at(root, "read-tree", "--empty");
    assert.deepEqual(await f.service.getPublishState(request), expected);
  });
  await t.test("SHA-256 object names and non-ASCII paths", async (t) => {
    const f = await publishFixture(t);
    const root = join(f.base, "sha256");
    await mkdir(root);
    await f.at(root, "init", "-q", "--object-format=sha256", "-b", "main");
    await writeFile(join(root, "中文 空格.txt"), "bytes\n");
    await f.at(root, "add", ".");
    const request = { ...f.request, workspacePath: root };
    const expected = await f.service.getPublishState(request);
    await utimes(join(root, "中文 空格.txt"), new Date(0), new Date(0));
    await f.at(root, "update-index", "--refresh");
    assert.deepEqual(await f.service.getPublishState(request), expected);
  });
});

test("unknown or incomplete index adapter output fails closed", async (t) => {
  for (const fault of ["format", "flags", "trailing", "truncated", "failed"])
    await t.test(fault, async (t) => {
      let armed = false;
      const f = await publishFixture(t, (command) => ({
        ...command,
        run: async (params) => {
          const result = await command.run(params);
          if (!armed || params.args[0] !== "ls-files" || !params.args.includes("--stage"))
            return result;
          if (fault === "truncated") return { ...result, outputTruncated: true };
          if (fault === "failed")
            return { ...result, exitCode: 2, stderr: "fixture index read failed" };
          return {
            ...result,
            stdout:
              fault === "format"
                ? result.stdout.replace("ctime:", "ctime-v2:")
                : fault === "flags"
                  ? result.stdout.replace(/flags: [0-9a-f]+/, "flags: unknown")
                  : result.stdout + "unknown-tail",
          };
        },
      }));
      armed = true;
      await assert.rejects(f.state(), /暂存区|格式|index|limit|exceeded|failed/);
    });
});

test("legacy raw-index approval cannot be silently upgraded or create a Tag", async (t) => {
  const f = await publishFixture(t);
  const current = await f.state();
  const legacy = {
    ...current,
    indexFingerprint: hash(
      JSON.stringify([await f.git("ls-files", "--stage", "-v", "-z"), hash(await indexBytes(f))]),
    ),
  };
  await assert.rejects(
    f.service.createTag({ ...f.request, name: "old-approval", expectedState: legacy }),
    /变化/,
  );
  assert.deepEqual((await f.service.listTags(f.request)).tags, []);
});

test("failed metadata reads settle the remaining Git IO before returning the error", async (t) => {
  let armed = false;
  let configStarted!: () => void;
  let configFinished!: () => void;
  let readFailed!: () => void;
  let releaseConfig!: () => void;
  const started = new Promise<void>((resolve) => {
    configStarted = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    configFinished = resolve;
  });
  const failed = new Promise<void>((resolve) => {
    readFailed = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseConfig = resolve;
  });
  const f = await publishFixture(t, (command) => ({
    ...command,
    run: async (params) => {
      const result = await command.run(params);
      if (armed && params.args[0] === "config" && params.args.includes("--get-regexp")) {
        configStarted();
        await gate;
        configFinished();
      }
      if (armed && params.args[0] === "ls-files" && params.args.includes("--stage")) {
        readFailed();
        return { ...result, outputTruncated: true };
      }
      return result;
    },
  }));
  armed = true;
  let settled = false;
  const pending = f.state().then(
    () => {
      settled = true;
      return null;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    await Promise.all([started, failed]);
    // 只让已经排队的 Promise 结算；用显式屏障保持另一个读取，不能以 sleep 掩盖悬挂 IO。
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
  } finally {
    releaseConfig();
    await finished;
    const error = await pending;
    assert.ok(error instanceof Error);
    assert.match(error.message, /exceeded|limit/);
  }
});
