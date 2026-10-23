import assert from "node:assert/strict";
import childProcess, { type ChildProcess, type SpawnOptions } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { runtimeMemoryBudget } from "@lcode/shared/node";
import { LCodeAgentProcessManager } from "./lcodeAgentProcessManager.js";

// 真实 stdio 子进程，只处理合成请求，不启动模型、读取用户配置或访问用户项目。
const fixtureScript = `
  let sequence = 0;
  const lines = require('node:readline').createInterface({ input: process.stdin });
  lines.on('line', line => {
    const request = JSON.parse(line);
    const response = request.params?.fail
      ? { id: request.id, error: { code: -32000, message: 'fixture error' } }
      : { id: request.id, result: {
          pid: process.pid, sequence: ++sequence, cwd: process.cwd(),
          identity: process.env.LCODE_WORKSPACE_IDENTITY ?? null,
          marker: process.env.LCODE_BACKGROUND_FIXTURE ?? null
        } };
    process.stdout.write(JSON.stringify(response) + '\\n');
  });
  lines.on('close', () => process.exit(0));
`;

type Result = {
  pid: number;
  sequence: number;
  cwd: string;
  identity: string | null;
  marker: string;
};
const workspace = { workspacePath: process.cwd() };

function fixture(t: TestContext) {
  const realSpawn = childProcess.spawn;
  const launches: { child: ChildProcess; options: SpawnOptions }[] = [];
  const reservations = new Set<symbol>();
  t.mock.method(runtimeMemoryBudget, "acquire", async () => {
    const token = Symbol();
    reservations.add(token);
    return { heapMb: 128, release: () => reservations.delete(token) };
  });
  t.mock.method(childProcess, "spawn", (...args: Parameters<typeof childProcess.spawn>) => {
    const [command, argv, options] = args;
    if (command !== process.execPath || argv?.[1] !== fixtureScript) return realSpawn(...args);
    // 先记录产品参数，再强制隐藏测试夹具；红灯验证也不能在用户桌面弹出控制台。
    const child = realSpawn(command, argv, { ...options, windowsHide: true });
    launches.push({ child, options: options ?? {} });
    return child;
  });
  syncBuiltinESMExports();
  const manager = new LCodeAgentProcessManager({
    commandResolver: () => ({ command: process.execPath, args: ["-e", fixtureScript] }),
    resolveSpawnEnv: async () => ({ LCODE_BACKGROUND_FIXTURE: "synthetic" }),
    requestTimeoutMs: 5_000,
  });
  t.after(async () => {
    try {
      await manager.disposeAllAndWait();
      assert.equal(reservations.size, 0);
      for (const { child } of launches) {
        assert.ok(child.exitCode !== null || child.signalCode !== null, "owned child must exit");
      }
    } finally {
      for (const { child } of launches) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
  return { manager, launches, reservations };
}

test("background Agent launch hides its console and preserves stdio, cwd and environment", async (t) => {
  const { manager, launches } = fixture(t);
  const client = await manager.getClient({ ...workspace, workspaceIdentity: "background-fixture" });
  const result = await client.request<Result>("runtime/capabilities", {});
  assert.equal(launches.length, 1);
  const launch = launches[0];
  assert.ok(launch);
  assert.equal(launch.options.windowsHide, true);
  assert.deepEqual(launch.options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(launch.options.detached, process.platform !== "win32");
  assert.equal(result.cwd, process.cwd());
  assert.equal(result.identity, "background-fixture");
  assert.equal(result.marker, "synthetic");
  assert.equal(result.pid, launch.child.pid);
  await assert.rejects(client.request("runtime/capabilities", { fail: true }), /fixture error/);
  assert.equal((await client.request<Result>("runtime/capabilities", {})).pid, result.pid);
});

test("concurrent and sequential requests reuse one Agent for the same workspace identity", async (t) => {
  const { manager, launches, reservations } = fixture(t);
  const clients = await Promise.all(Array.from({ length: 7 }, () => manager.getClient(workspace)));
  assert.ok(clients.every((client) => client === clients[0]));
  assert.equal(launches.length, 1);
  assert.equal(reservations.size, 1);
  const client = clients[0];
  assert.ok(client);
  const first = await client.request<Result>("runtime/capabilities", {});
  const second = await (
    await manager.getClient(workspace)
  ).request<Result>("runtime/capabilities", {});
  assert.equal(second.pid, first.pid);
  assert.equal(second.sequence, first.sequence + 1);
  assert.equal(launches.length, 1);
});

test("same-directory identities remain isolated and disposing one leaves the other usable", async (t) => {
  const { manager, launches, reservations } = fixture(t);
  const scopeA = { ...workspace, workspaceIdentity: "background-fixture-a" };
  const scopeB = { ...workspace, workspaceIdentity: "background-fixture-b" };
  const [a, b] = await Promise.all([manager.getClient(scopeA), manager.getClient(scopeB)]);
  const firstA = await a.request<Result>("runtime/capabilities", {});
  const firstB = await b.request<Result>("runtime/capabilities", {});
  assert.notEqual(firstA.pid, firstB.pid);
  assert.equal(firstA.identity, scopeA.workspaceIdentity);
  assert.equal(firstB.identity, scopeB.workspaceIdentity);
  await manager.disposeWorkspace(scopeA);
  assert.equal(reservations.size, 1);
  assert.equal(manager.getExistingClient(scopeA), undefined);
  assert.equal(await manager.getClient(scopeB), b);
  assert.equal((await b.request<Result>("runtime/capabilities", {})).pid, firstB.pid);
  assert.equal(launches.length, 2);
  assert.equal(launches.find(({ child }) => child.pid === firstA.pid)?.child.exitCode, 0);
});

test("workspace disposal is idempotent and a later launch receives a new runtime generation", async (t) => {
  const { manager, launches, reservations } = fixture(t);
  const client = await manager.getClient(workspace);
  await client.request("runtime/capabilities", {});
  const oldOwner = manager.getOwnedProcessOwner(client);
  assert.ok(oldOwner);
  await manager.disposeWorkspace(workspace);
  await manager.disposeWorkspace(workspace);
  assert.equal(reservations.size, 0);
  assert.equal(manager.getOwnedProcessOwner(client), undefined);
  const oldLaunch = launches[0];
  assert.ok(oldLaunch);
  assert.equal(oldLaunch.child.exitCode, 0);
  const next = await manager.getClient(workspace);
  const result = await next.request<Result>("runtime/capabilities", {});
  const nextOwner = manager.getOwnedProcessOwner(next);
  assert.ok(nextOwner);
  assert.notEqual(next, client);
  assert.equal(nextOwner.runtimeGeneration, oldOwner.runtimeGeneration + 1);
  assert.notEqual(nextOwner.runtimeInstanceId, oldOwner.runtimeInstanceId);
  const newLaunch = launches[1];
  assert.ok(newLaunch);
  assert.equal(result.pid, newLaunch.child.pid);
  assert.equal(reservations.size, 1);
});
