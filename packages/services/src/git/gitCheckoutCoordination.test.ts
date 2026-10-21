import assert from "node:assert/strict";
import test from "node:test";
import type { IGitService } from "./git.js";
import { coordinateGitCheckoutWrites } from "./gitCheckoutCoordination.js";
import { createCheckoutCoordinator } from "../worktree/node.js";
import { publishFixture } from "./gitPublishTestHelpers.js";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { gitOperationKey } from "./gitNetworkJournal.js";

test("人工保存和标记仅按原 owner 计算 bypass，强制 common/checkout 双独占", async () => {
  const acquired: unknown[] = [],
    query = {
      workspacePath: "/selected/subdir",
      workspaceIdentity: "remote:fixture",
      requestId: "original",
    };
  const source = {
    requestId: "original",
    kind: "stash-apply",
    status: "conflict",
    targetPath: "/actual/checkout",
    startedAt: "fixture",
  };
  const service = coordinateGitCheckoutWrites(
    {
      getNetworkOperation: async (params: { requestId: string }) =>
        params.requestId === "original" ? source : null,
      saveConflictResult: async () => ({ status: "success" }),
      markConflictResolved: async () => ({ status: "success" }),
    } as unknown as IGitService,
    {
      acquire: async (params) => {
        assert.equal(params.workspacePath, source.targetPath);
        assert.equal(params.resource, "repository-checkout");
        assert.equal(params.mode, "exclusive");
        assert.equal(params.allowReservationKey, gitOperationKey(query));
        acquired.push(params);
        return { ...params, token: "permit" };
      },
      release: async () => {},
    },
  );
  const command = {
    ...query,
    sourceRequestId: "original",
    expectedRevision: "a".repeat(64),
    path: "f.txt",
    confirmNativeStopped: false,
  };
  await service.saveConflictResult({
    ...command,
    requestId: "save",
    action: "save",
    text: "result",
  });
  await service.markConflictResolved({ ...command, requestId: "mark", confirmSpecial: false });
  assert.equal(acquired.length, 2);
  await assert.rejects(
    service.saveConflictResult({
      ...command,
      requestId: "inject",
      action: "save",
      text: "result",
      allowReservationKey: "b".repeat(64),
    } as never),
  );
  assert.equal(acquired.length, 2);
});

test("only mutations acquire writer permits; reads and refresh remain available", async () => {
  let acquired = 0,
    released = 0;
  const service = coordinateGitCheckoutWrites(
    {
      stagePaths: async () => {
        throw new Error("fixture-stage");
      },
      refresh: async () => "read",
      getRepositorySummary: async () => "summary",
    } as unknown as IGitService,
    {
      acquire: async (params) => {
        acquired++;
        return { token: "token", ownerId: params.ownerId, workspacePath: params.workspacePath };
      },
      release: async () => {
        released++;
      },
    },
  );
  const params = { workspacePath: "/fixture" };
  assert.equal(await service.refresh(params), "read");
  assert.equal(await service.getRepositorySummary(params), "summary");
  assert.equal(acquired, 0);
  await assert.rejects(service.stagePaths({ ...params, paths: ["x.ts"] }), /fixture-stage/);
  assert.equal(acquired, 1);
  assert.equal(released, 1);
});

test("Continue/Abort 仅 Host 从原收据派生 checkout 与 key，并保持 common→checkout 写入", async () => {
  let acquired = 0;
  const query = {
    workspacePath: "/scope/subdir",
    workspaceIdentity: " original:identity ",
    requestId: "source",
  };
  const service = coordinateGitCheckoutWrites(
    {
      getNetworkOperation: async (params: { requestId: string }) =>
        params.requestId === "source"
          ? {
              requestId: "source",
              kind: "rebase",
              status: "conflict",
              targetPath: "/actual/repo",
              startedAt: "fixture",
            }
          : null,
      continueIntegration: async () => ({ status: "conflict" }),
      abortIntegration: async () => ({ status: "success" }),
    } as unknown as IGitService,
    {
      acquire: async (params) => {
        acquired++;
        assert.equal(params.workspacePath, "/actual/repo");
        assert.equal(params.allowReservationKey, gitOperationKey(query));
        assert.equal(params.mode, "exclusive");
        assert.equal(params.resource, "repository-checkout");
        return { ...params, token: "permit" };
      },
      release: async () => {},
    },
  );
  const params = {
    ...query,
    requestId: "next",
    sourceRequestId: "source",
    expectedRevision: "a".repeat(64),
    confirmNativeStopped: false,
    confirmDiscard: true,
  };
  await service.continueIntegration(params);
  await service.abortIntegration({ ...params, requestId: "abort" });
  await assert.rejects(
    service.abortIntegration({ ...params, allowReservationKey: "injected" } as never),
  );
  assert.equal(acquired, 2);
});

test("orphaned Git 保留 writer，未确认退出前不放行下一次写入", async () => {
  let released = false;
  const wrapped = coordinateGitCheckoutWrites(
    {
      fetchRemotes: async () => ({ status: "unknown", unsettled: true }),
    } as unknown as IGitService,
    {
      acquire: async (params) => ({
        token: "held",
        ownerId: params.ownerId,
        workspacePath: params.workspacePath,
      }),
      release: async () => {
        released = true;
      },
    },
  );
  const result = await wrapped.fetchRemotes({
    workspacePath: "/fixture",
    requestId: "one",
    expectedRevision: "a".repeat(64),
    remotes: ["origin"],
  });
  assert.equal(result.unsettled, true);
  assert.equal(released, false);
});

test("全部 Git mutation 同一写入许可，identity 原样贯通，失败也释放", async () => {
  const names = [
    "switchBranch",
    "createBranchAndSwitch",
    "deleteBranch",
    "stagePaths",
    "unstagePaths",
    "discardPaths",
    "commit",
    "commitAndSwitchBranch",
    "push",
    "createTag",
    "mutateRemote",
    "setBranchTracking",
    "fetchRemotes",
    "fastForward",
    "saveStash",
    "applyStash",
    "dropStash",
  ];
  const events: string[] = [];
  const wrapped = coordinateGitCheckoutWrites(
    Object.fromEntries(
      names.map((name) => [
        name,
        async () => {
          events.push(name);
          throw new Error("expected");
        },
      ]),
    ) as unknown as IGitService,
    {
      acquire: async (params) => {
        assert.equal(params.workspaceIdentity, "remote:fixture");
        assert.equal(params.waitMs, 0);
        assert.equal(params.mode, "exclusive");
        assert.match(params.ownerId, /^git:/);
        events.push("acquire");
        return { ...params, token: "permit" };
      },
      release: async () => {
        events.push("release");
      },
    },
  );
  for (const name of names) {
    await assert.rejects(
      Reflect.apply(Reflect.get(wrapped, name), wrapped, [
        {
          workspacePath: "/fixture",
          workspaceIdentity: "remote:fixture",
          mode: "shared",
          ownerId: "untrusted",
          waitMs: 60000,
          resource: "checkout",
        },
      ]),
      /expected/,
    );
    assert.deepEqual(events.splice(0), ["acquire", name, "release"]);
  }
});

test("common-dir 写入跨 Host/linked worktree 互斥，Agent shared 允许 Fetch、阻止同 checkout 更新", async (t) => {
  const f = await publishFixture(t);
  const git = {
    run: async ({ cwd, args }: { cwd: string; args: string[] }) => ({
      stdout: await f.at(cwd, ...args),
      stderr: "",
      exitCode: 0,
    }),
  };
  const options = { git, dataDir: join(f.base, "common-data") };
  const first = createCheckoutCoordinator(options),
    second = createCheckoutCoordinator(options);
  const other = join(f.base, "linked");
  await f.git("worktree", "add", "-qb", "other", other);
  const common = await first.acquire({
    workspacePath: f.root,
    ownerId: "fetch",
    resource: "repository",
    waitMs: 0,
  });
  try {
    await assert.rejects(
      second.acquire({
        workspacePath: other,
        ownerId: "config",
        resource: "repository",
        waitMs: 0,
      }),
      { code: "LCODE_CHECKOUT_BUSY" },
    );
    await assert.rejects(
      second.acquire({ workspacePath: other, ownerId: "worktree-writer", waitMs: 0 }),
      { code: "LCODE_CHECKOUT_BUSY" },
    );
    const agent = await second.acquire({
      workspacePath: other,
      ownerId: "agent",
      mode: "shared",
      waitMs: 0,
    });
    await second.release(agent);
  } finally {
    await first.release(common);
  }
  const agent = await first.acquire({
    workspacePath: f.root,
    ownerId: "agent",
    mode: "shared",
    waitMs: 0,
  });
  try {
    const fetch = await second.acquire({
      workspacePath: other,
      ownerId: "fetch",
      resource: "repository",
      waitMs: 0,
    });
    await second.release(fetch);
    await assert.rejects(
      second.acquire({
        workspacePath: f.root,
        ownerId: "update",
        resource: "repository-checkout",
        waitMs: 0,
      }),
      { code: "LCODE_CHECKOUT_BUSY" },
    );
    // 第二把 checkout 锁失败必须释放先拿的 common 锁。
    const after = await second.acquire({
      workspacePath: other,
      ownerId: "after",
      resource: "repository",
      waitMs: 0,
    });
    await second.release(after);
  } finally {
    await first.release(agent);
  }
});

test("两个 Host 同 checkout 排他且读可用，独立 worktree 文件写入并行", async (t) => {
  const f = await publishFixture(t);
  const git = {
    run: async ({ cwd, args }: { cwd: string; args: string[] }) => {
      try {
        return { stdout: await f.at(cwd, ...args), stderr: "", exitCode: 0 };
      } catch (error) {
        return { stdout: "", stderr: String(error), exitCode: 1 };
      }
    },
  };
  const options = { git, dataDir: join(f.base, "host-data") };
  const first = createCheckoutCoordinator(options);
  const second = createCheckoutCoordinator(options);
  const lease = await first.acquire({
    ...f.request,
    ownerId: "agent-run",
    mode: "shared",
    waitMs: 0,
  });
  const service = coordinateGitCheckoutWrites(f.service, second);
  try {
    await writeFile(join(f.root, "a.txt"), "pending\n");
    assert.equal((await service.refresh(f.request)).unstagedChanges.length, 1);
    await assert.rejects(service.stagePaths({ ...f.request, paths: ["a.txt"] }), {
      code: "LCODE_CHECKOUT_BUSY",
    });
    assert.equal((await f.git("diff", "--cached")).trim(), "");
    const other = join(f.base, "linked");
    await f.git("worktree", "add", "-q", "-b", "other", other);
    await writeFile(join(other, "a.txt"), "independent\n");
    await service.stagePaths({ workspacePath: other, paths: ["a.txt"] });
    assert.match(await f.at(other, "diff", "--cached"), /independent/);
  } finally {
    await first.release(lease);
  }
  await service.stagePaths({ ...f.request, paths: ["a.txt"] });
  assert.match(await f.git("diff", "--cached"), /pending/);
});
