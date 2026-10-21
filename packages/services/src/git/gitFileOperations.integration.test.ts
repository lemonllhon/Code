import assert from "node:assert/strict";
import { lstat, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { publishFixture } from "./gitPublishTestHelpers.js";
import { coordinateGitCheckoutWrites } from "./gitCheckoutCoordination.js";

test("暂存/取消暂存只操作具体文件，字面通配符和无关暂存保持", async (t) => {
  const f = await publishFixture(t);
  await writeFile(join(f.root, "b.txt"), "unrelated staged\n");
  await f.git("add", "b.txt");
  await writeFile(join(f.root, "a.txt"), "edited\n");
  await writeFile(join(f.root, "[one].txt"), "literal\n");
  await writeFile(join(f.root, "o.txt"), "neighbor\n");
  await f.service.stagePaths({
    ...f.request,
    paths: ["[one].txt", "a.txt"],
    expectedState: await f.state(),
  });
  assert.match(await f.git("show", ":[one].txt"), /literal/);
  assert.equal((await f.git("diff", "--cached", "--name-only")).includes("o.txt"), false);
  await f.service.unstagePaths({
    ...f.request,
    paths: ["a.txt", "[one].txt"],
    expectedState: await f.state(),
  });
  assert.equal((await f.git("diff", "--cached", "--name-only")).trim(), "b.txt");
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "edited\n");
});

test("丢弃工作树恢复 index；未跟踪文件精确删除，ignored 和邻居保持", async (t) => {
  const f = await publishFixture(t);
  await writeFile(join(f.root, "a.txt"), "index version\n");
  await f.git("add", "a.txt");
  await writeFile(join(f.root, "a.txt"), "working version\n");
  await writeFile(join(f.root, ".gitignore"), "keep.log\n");
  await writeFile(join(f.root, "keep.log"), "ignored\n");
  await mkdir(join(f.root, "new"));
  await writeFile(join(f.root, "new", "中文 file.txt"), "remove\n");
  await writeFile(join(f.root, "new", "keep.txt"), "keep\n");
  await f.service.discardPaths({
    ...f.request,
    paths: ["a.txt", "new/中文 file.txt"],
    expectedState: await f.state(),
  });
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "index version\n");
  assert.equal(await f.git("show", ":a.txt"), "index version\n");
  await assert.rejects(lstat(join(f.root, "new", "中文 file.txt")), { code: "ENOENT" });
  assert.equal(await readFile(join(f.root, "new", "keep.txt"), "utf8"), "keep\n");
  assert.equal(await readFile(join(f.root, "keep.log"), "utf8"), "ignored\n");
});

test("已暂存丢弃恢复 HEAD，新增文件内容保留为未跟踪", async (t) => {
  const f = await publishFixture(t);
  await writeFile(join(f.root, "a.txt"), "index\n");
  await writeFile(join(f.root, "added.txt"), "new content\n");
  await f.git("add", "a.txt", "added.txt");
  await writeFile(join(f.root, "a.txt"), "working\n");
  await f.service.discardPaths({
    ...f.request,
    paths: ["a.txt", "added.txt"],
    staged: true,
    expectedState: await f.state(),
  });
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "one\n");
  assert.equal(await readFile(join(f.root, "added.txt"), "utf8"), "new content\n");
  assert.equal((await f.git("diff", "--cached")).trim(), "");
});

test("确认过期或缺失、目录、ignored、pathspec、越界整批拒绝且不提前写入", async (t) => {
  const f = await publishFixture(t);
  await writeFile(join(f.root, "a.txt"), "before confirm\n");
  const expectedState = await f.state();
  await writeFile(join(f.root, "a.txt"), "after confirm\n");
  await assert.rejects(
    f.service.discardPaths({ ...f.request, paths: ["a.txt"], expectedState }),
    /变化/,
  );
  await assert.rejects(f.service.discardPaths({ ...f.request, paths: ["a.txt"] } as never));
  await writeFile(join(f.root, ".gitignore"), "keep.log\n");
  await writeFile(join(f.root, "keep.log"), "ignored\n");
  await mkdir(join(f.root, "folder"));
  for (const path of [".", "folder", ".git/config", "../outside", ":(glob)*", "keep.log"]) {
    await assert.rejects(f.service.stagePaths({ ...f.request, paths: ["a.txt", path] }), path);
    await assert.rejects(
      f.service.discardPaths({
        ...f.request,
        paths: ["a.txt", path],
        expectedState: await f.state(),
      }),
      path,
    );
    assert.equal((await f.git("diff", "--cached")).trim(), "");
    assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "after confirm\n");
  }
});

test("重命名的取消暂存和已暂存丢弃覆盖配对路径", async (t) => {
  const f = await publishFixture(t);
  await rename(join(f.root, "a.txt"), join(f.root, "renamed.txt"));
  await f.git("add", "-A");
  await f.service.unstagePaths({ ...f.request, paths: ["renamed.txt"] });
  assert.equal((await f.git("diff", "--cached")).trim(), "");
  await f.git("add", "-A");
  await f.service.discardPaths({
    ...f.request,
    paths: ["renamed.txt"],
    staged: true,
    expectedState: await f.state(),
  });
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "one\n");
  assert.equal(await readFile(join(f.root, "renamed.txt"), "utf8"), "one\n");
});

test("unborn 分支允许取消暂存并保持新文件", async (t) => {
  const f = await publishFixture(t);
  await f.git("checkout", "--orphan", "empty");
  await assert.rejects(
    f.service.discardPaths({
      ...f.request,
      paths: ["a.txt"],
      staged: true,
      expectedState: await f.state(),
    }),
    /first commit/,
  );
  assert.equal((await f.git("ls-files")).trim(), "a.txt\nb.txt");
  await f.service.unstagePaths({ ...f.request, paths: ["a.txt", "b.txt"] });
  assert.equal((await f.git("ls-files")).trim(), "");
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "one\n");
});

test("子工作区不能写兄弟路径或穿越符号链接目录", async (t) => {
  const f = await publishFixture(t);
  const sub = join(f.root, "sub");
  await mkdir(sub);
  await writeFile(join(sub, "x.txt"), "inside\n");
  await assert.rejects(
    f.service.stagePaths({ ...f.request, workspacePath: sub, paths: ["../a.txt"] }),
  );
  await mkdir(join(f.base, "outside"));
  await writeFile(join(f.base, "outside", "keep.txt"), "outside\n");
  await symlink(
    join(f.base, "outside"),
    join(sub, "link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    f.service.stagePaths({ ...f.request, workspacePath: sub, paths: ["x.txt", "link/keep.txt"] }),
  );
  assert.equal((await f.git("diff", "--cached")).trim(), "");
});

test("提交再切分支一次命令保留无关暂存，切换失败仍返回成功提交事实", async (t) => {
  const f = await publishFixture(t);
  await writeFile(join(f.root, "b.txt"), "unrelated index\n");
  await f.git("add", "b.txt");
  await writeFile(join(f.root, "a.txt"), "selected\n");
  let acquired = 0,
    released = 0;
  const service = coordinateGitCheckoutWrites(f.service, {
    acquire: async (params) => {
      acquired++;
      assert.equal(params.workspaceIdentity, f.request.workspaceIdentity);
      return { ...params, token: "fixture" };
    },
    release: async () => {
      released++;
    },
  });
  const result = await service.commitAndSwitchBranch({
    ...f.request,
    paths: ["a.txt"],
    message: "selected only",
    targetBranchName: "absent",
    expectedState: await f.state(),
  });
  assert.equal(result.commit.commitHash, (await f.git("rev-parse", "HEAD")).trim());
  assert.equal(result.switchResult?.ok, false);
  assert.equal(await f.git("show", "HEAD:b.txt"), "two\n");
  assert.equal(await f.git("show", ":b.txt"), "unrelated index\n");
  assert.equal(await f.git("show", "HEAD:a.txt"), "selected\n");
  assert.equal(acquired, 1);
  assert.equal(released, 1);
});

test("确认后 index 或 HEAD 改变也拒绝丢弃和提交切换", async (t) => {
  const f = await publishFixture(t);
  await writeFile(join(f.root, "a.txt"), "keep\n");
  const beforeIndex = await f.state();
  await f.git("add", "a.txt");
  await assert.rejects(
    f.service.discardPaths({
      ...f.request,
      paths: ["a.txt"],
      staged: true,
      expectedState: beforeIndex,
    }),
    /变化/,
  );
  const beforeHead = await f.state();
  await f.git("commit", "--allow-empty", "-qm", "external");
  await assert.rejects(
    f.service.commitAndSwitchBranch({
      ...f.request,
      paths: ["a.txt"],
      message: "stale",
      targetBranchName: "main",
      expectedState: beforeHead,
    }),
  );
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "keep\n");
});

test("丢弃第二步失败返回真实错误，刷新保留已完成的 index 事实", async (t) => {
  const f = await publishFixture(t, (command) => ({
    ...command,
    run: async (options) => {
      if (options.args.includes("restore") && options.args.includes("--worktree"))
        throw new Error("fixture second write failed");
      return command.run(options);
    },
  }));
  await writeFile(join(f.root, "a.txt"), "staged\n");
  await f.git("add", "a.txt");
  await assert.rejects(
    f.service.discardPaths({
      ...f.request,
      paths: ["a.txt"],
      staged: true,
      expectedState: await f.state(),
    }),
    /second write failed/,
  );
  const state = await f.service.refresh(f.request);
  assert.equal(state.stagedChanges.length, 0);
  assert.equal(state.unstagedChanges.length, 1);
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "staged\n");
});

test("合法提交切分支成功", async (t) => {
  const f = await publishFixture(t);
  await f.git("branch", "topic");
  await writeFile(join(f.root, "a.txt"), "selected\n");
  const expectedState = await f.state();
  const result = await f.service.commitAndSwitchBranch({
    ...f.request,
    paths: ["a.txt"],
    message: "selected",
    targetBranchName: "topic",
    expectedState,
  });
  assert.equal(result.switchResult?.ok, true);
  assert.equal((await f.git("branch", "--show-current")).trim(), "topic");
  assert.equal(await f.git("show", `${result.commit.commitHash}:a.txt`), "selected\n");
});

test("大量长路径按字节分批完成暂存、取消与精确丢弃，不触发 Windows argv 上限", async (t) => {
  const f = await publishFixture(t);
  const paths = Array.from(
    { length: 600 },
    (_, index) => `file-${String(index).padStart(4, "0")}-${"long-name-".repeat(7)}.txt`,
  );
  await Promise.all(paths.map((path) => writeFile(join(f.root, path), "new\n")));
  await f.service.stagePaths({ ...f.request, paths });
  assert.equal(
    (await f.git("diff", "--cached", "--name-only", "-z")).split("\0").filter(Boolean).length,
    600,
  );
  await f.service.unstagePaths({ ...f.request, paths });
  assert.equal((await f.git("diff", "--cached")).trim(), "");
  await f.service.discardPaths({ ...f.request, paths, expectedState: await f.state() });
  assert.equal((await f.git("ls-files", "--others", "--exclude-standard")).trim(), "");
  assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "one\n");
});
