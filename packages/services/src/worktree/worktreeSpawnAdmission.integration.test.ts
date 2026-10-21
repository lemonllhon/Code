import assert from "node:assert/strict";
import { access, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fixture } from "./testFixture.js";
import {
  createPublicWorktreeService,
  createWorktreeService,
  createCheckoutCoordinator,
} from "./node.js";
import { createLCodeAgentService } from "../lcode-agent/lcodeAgentService.js";
import { setDataBaseDir } from "../paths.js";

test("Git 未完成 reservation 在重启后的 Host admission 阻止 Agent spawn，且不暴露 RPC bypass", async (t) => {
  const f = await fixture(t);
  const coordinator = createCheckoutCoordinator(f.options);
  await coordinator.setReservation!({
    workspacePath: f.repo,
    operationKey: "a".repeat(64),
    kind: "stash-apply",
  });
  const restarted = createWorktreeService(f.options);
  const marker = join(f.root, "unexpected-git-spawn");
  const agents = createLCodeAgentService({
    requestTimeoutMs: 200,
    worktreeService: restarted,
    assertWorktreeExecutionAdmission: (scope) => restarted.assertExecutionAdmission(scope),
    commandResolver: () => ({
      command: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'spawned')`],
    }),
  });
  t.after(() => agents.disposeAllAndWait());
  await assert.rejects(
    agents.listSessions({ workspacePath: f.repo, workspaceIdentity: "other-window" }),
    { code: "LCODE_CHECKOUT_RESERVED" },
  );
  await assert.rejects(access(marker), { code: "ENOENT" });
  for (const kind of ["conflict-resolution", "integration"] as const) {
    await coordinator.setReservation!({
      workspacePath: f.repo,
      operationKey: "a".repeat(64),
      kind,
    });
    await assert.rejects(
      agents.listSessions({ workspacePath: f.repo, workspaceIdentity: "manual-window" }),
      { code: "LCODE_CHECKOUT_RESERVED" },
    );
    await assert.rejects(access(marker), { code: "ENOENT" });
  }
  assert.equal("clearReservation" in createPublicWorktreeService(restarted), false);
  await coordinator.clearReservation!({ workspacePath: f.repo, operationKey: "a".repeat(64) });
  await restarted.assertExecutionAdmission({ workspacePath: f.repo });
});

test("a fresh Host cannot respawn a failed deletion through background subdirectory reads", async (t) => {
  const f = await fixture(t);
  setDataBaseDir(f.root);
  const worktrees = createWorktreeService({
    ...f.options,
    stopWorktreeExecution: async () => {
      throw new Error("fixture stop interrupted");
    },
  });
  const binding = await worktrees.prepare({
    workspacePath: f.repo,
    taskId: "owner",
    requestId: "prepare",
    environmentPolicy: "local",
    setupCommands: [],
  });
  const scope = {
    workspacePath: join(binding.checkoutPath, "packages", "server"),
    workspaceIdentity: binding.workspaceIdentity,
  };
  await mkdir(scope.workspacePath, { recursive: true });
  await assert.rejects(
    worktrees.archive({
      bindingId: binding.id,
      requestId: "delete",
      discard: { branch: binding.branch, checkoutPath: binding.checkoutPath },
    }),
    /stop interrupted/,
  );
  const fresh = createWorktreeService(f.options);
  const marker = join(f.root, "unexpected-spawn");
  const agents = createLCodeAgentService({
    requestTimeoutMs: 200,
    worktreeService: fresh,
    assertWorktreeExecutionAdmission: (scope) => fresh.assertExecutionAdmission(scope),
    commandResolver: () => ({
      command: process.execPath,
      args: [
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(marker)},'spawned');require('node:readline').createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l);if(r.id!==undefined)process.stdout.write(JSON.stringify({id:r.id,result:{sessions:[]}})+String.fromCharCode(10))})`,
      ],
    }),
  });
  t.after(async () => {
    await agents.disposeAllAndWait();
    setDataBaseDir(null);
  });
  await assert.rejects(agents.listSessions(scope), /admission is fenced/);
  await assert.rejects(access(marker), { code: "ENOENT" });
  await assert.rejects(fresh.assertExecutionAdmission(scope), /admission is fenced/);
  await fresh.assertExecutionAdmission({ workspacePath: f.repo });
  await fresh.assertExecutionAdmission({ ...scope, workspaceIdentity: "another-host" });
  assert.equal("assertExecutionAdmission" in createPublicWorktreeService(fresh), false);
  assert.equal(
    (
      await fresh.archive({
        bindingId: binding.id,
        requestId: "retry",
        discard: { branch: binding.branch, checkoutPath: binding.checkoutPath },
      })
    ).status,
    "deleted",
  );
  await assert.rejects(fresh.assertExecutionAdmission(scope), /admission is fenced/);
});

test("ready and restored checkouts remain available; physical links outside a deleting tree remain separate", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({
    workspacePath: f.repo,
    taskId: "owner",
    requestId: "prepare",
    environmentPolicy: "local",
    setupCommands: [],
  });
  const scope = {
    workspacePath: binding.checkoutPath,
    workspaceIdentity: binding.workspaceIdentity,
  };
  await f.service.assertExecutionAdmission(scope);
  await f.service.archive({ bindingId: binding.id, requestId: "archive" });
  await assert.rejects(
    createWorktreeService(f.options).assertExecutionAdmission(scope),
    /admission is fenced/,
  );
  await f.service.restore({ bindingId: binding.id, requestId: "restore" });
  await createWorktreeService(f.options).assertExecutionAdmission(scope);
  const outside = join(f.root, "outside");
  await mkdir(outside);
  const link = join(binding.checkoutPath, "linked");
  await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  const failing = createWorktreeService({
    ...f.options,
    stopWorktreeExecution: async () => {
      throw new Error("stop interrupted");
    },
  });
  await assert.rejects(
    failing.archive({
      bindingId: binding.id,
      requestId: "delete",
      discard: { branch: binding.branch, checkoutPath: binding.checkoutPath },
    }),
    /stop interrupted/,
  );
  await failing.assertExecutionAdmission({ ...scope, workspacePath: link });
  await failing.assertExecutionAdmission({
    ...scope,
    workspacePath: `${binding.checkoutPath}-other`,
  });
});
