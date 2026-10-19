import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistryImpl } from "../registry.js";
import { ToolScheduler } from "../scheduler.js";
import type { ExecutableToolCall, ToolEntry } from "../types.js";
import { createToolExecutor } from "./impl.js";
import type { ToolExecutorOptions } from "./types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = () => new Promise<void>((done) => setImmediate(done));
const calls = (ids: string[]): ExecutableToolCall[] =>
  ids.map((id) => ({ id, name: "Read", input: {} }) as ExecutableToolCall);
function fixture(limit = 2, options: Partial<ToolExecutorOptions> = {}) {
  const registry = new ToolRegistryImpl();
  const started: string[] = [];
  const gates = new Map<string, ReturnType<typeof deferred>>();
  for (const id of ["A", "B", "C", "D"]) gates.set(id, deferred());
  registry.register({
    metadata: {
      name: "Read",
      readOnly: true,
      concurrentSafe: true,
      destructive: false,
      needsApproval: false,
      sideEffectScope: "none",
      riskLevel: "low",
    },
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    handler: async (_input, context) => {
      started.push(context.toolCallId);
      await gates.get(context.toolCallId)!.promise;
      return {};
    },
  } as ToolEntry);
  const executor = createToolExecutor({
    registry,
    maxConcurrency: limit,
    permissionService: { checkPermission: () => ({ allowed: true, decision: "allow" }) } as never,
    emitEvent: async () => {},
    sessionId: "fixture" as never,
    getMode: () => "yolo",
    ...options,
  });
  return {
    executor,
    registry,
    started,
    gates,
    release: () => gates.forEach((gate) => gate.resolve()),
  };
}

test("direct and batch calls share the executor limit; larger overrides cannot bypass it", async () => {
  const f = fixture(2);
  const pending = [
    f.executor.execute(calls(["A"])[0]!),
    f.executor.executeBatch(calls(["B", "C", "D"]), { maxConcurrency: 10 }),
  ];
  try {
    await tick();
    assert.equal(f.started.length, 2);
  } finally {
    f.release();
    await Promise.all(pending);
  }
});

test("one hundred ready tools keep the default ten handler limit", async () => {
  const f = fixture(2, { maxConcurrency: undefined });
  const ids = Array.from({ length: 100 }, (_, index) => `read-${index}`);
  for (const id of ids) f.gates.set(id, deferred());
  const pending = f.executor.executeBatch(calls(ids));
  try {
    await tick();
    assert.equal(f.started.length, 10);
  } finally {
    f.release();
  }
  const results = await pending;
  assert.equal(results.length, 100);
  assert.ok(results.every((result) => result.success));
  assert.deepEqual(
    results.map((result) => result.toolCallId),
    ids,
  );
});

test("ready tools refill a safe stage before its slowest tool finishes", async () => {
  const f = fixture(2);
  const tools = calls(["A", "B", "C"]);
  const schedule = new ToolScheduler({ maxConcurrency: 2 }).schedule(
    tools.map((t) => ({
      toolCallId: t.id,
      toolName: t.name,
      dependsOn: [],
      readOnly: true,
      concurrentSafe: true,
      sideEffectScope: "none",
    })),
  );
  const pending = (async () => {
    const generator = f.executor.executeSchedule(tools, schedule);
    while (true) {
      const next = await generator.next();
      if (next.done) return next.value;
    }
  })();
  try {
    await tick();
    assert.deepEqual(f.started, ["A", "B"]);
    f.gates.get("B")!.resolve();
    await tick();
    assert.deepEqual(f.started, ["A", "B", "C"]);
  } finally {
    f.release();
  }
  assert.deepEqual(
    (await pending).map((r) => r.toolCallId),
    ["A", "B", "C"],
  );
});

test("cancelled handlers retain their permit until real cleanup, queued cancellation never starts", async () => {
  const f = fixture(1);
  const activeAbort = new AbortController(),
    queuedAbort = new AbortController();
  const first = f.executor.execute(calls(["A"])[0]!, { signal: activeAbort.signal });
  await tick();
  activeAbort.abort();
  assert.equal((await first).success, false);
  const second = f.executor.execute(calls(["B"])[0]!, { signal: queuedAbort.signal });
  try {
    await tick();
    assert.deepEqual(f.started, ["A"]);
    queuedAbort.abort();
    assert.equal((await second).success, false);
    f.gates.get("A")!.resolve();
    const third = f.executor.execute(calls(["C"])[0]!);
    await tick();
    assert.deepEqual(f.started, ["A", "C"]);
    f.gates.get("C")!.resolve();
    assert.equal((await third).success, true);
  } finally {
    f.release();
  }
});

test("permission waiting holds no execution slot or running state", async () => {
  const approval = deferred(),
    requested = deferred();
  const running: string[] = [];
  const f = fixture(1, {
    permissionService: {
      checkPermission: (context) =>
        context.toolName === "Approval"
          ? { allowed: false, decision: "ask", riskLevel: "low", sideEffectScope: "none" }
          : { allowed: true, decision: "allow" },
    } as ToolExecutorOptions["permissionService"],
    permissionBroker: {
      requestPermission: async () => {
        requested.resolve();
        await approval.promise;
        return { decision: "allow" };
      },
    } as ToolExecutorOptions["permissionBroker"],
  });
  const entry = f.registry.get("Read")!;
  f.registry.register({ ...entry, metadata: { ...entry.metadata, name: "Approval" } });
  const options = {
    onToolStart: (id: string) => {
      running.push(id);
    },
  };
  const waiting = f.executor.execute({ ...calls(["A"])[0]!, name: "Approval" }, options);
  await requested.promise;
  const immediate = f.executor.execute(calls(["B"])[0]!, options);
  try {
    await tick();
    assert.deepEqual(f.started, ["B"]);
    assert.deepEqual(running, ["B"]);
    f.gates.get("B")!.resolve();
    assert.equal((await immediate).success, true);
    approval.resolve();
    await tick();
    assert.deepEqual(f.started, ["B", "A"]);
  } finally {
    approval.resolve();
    f.release();
  }
  assert.equal((await waiting).success, true);
});

test("terminal stage prevents later ready tools from starting and still closes their results", async () => {
  const f = fixture(2);
  const entry = f.registry.get("Read")!;
  f.registry.register({
    ...entry,
    metadata: { ...entry.metadata, name: "Terminal", stopTurnOnSuccess: true },
  });
  const tools = [calls(["A"])[0]!, { ...calls(["B"])[0]!, name: "Terminal" }, calls(["C"])[0]!];
  const schedule = new ToolScheduler().schedule(
    tools.map((tool) => ({
      toolCallId: tool.id,
      toolName: tool.name,
      dependsOn: [],
      readOnly: true,
      concurrentSafe: true,
      sideEffectScope: "none",
      stopTurnOnSuccess: tool.name === "Terminal",
    })),
  );
  f.release();
  const generator = f.executor.executeSchedule(tools, schedule);
  let results;
  while (true) {
    const next = await generator.next();
    if (next.done) {
      results = next.value;
      break;
    }
  }
  assert.deepEqual(f.started, ["A", "B"]);
  assert.deepEqual(
    results.map((result) => result.toolCallId),
    ["A", "B", "C"],
  );
  assert.equal(results[1]?.turnControl?.stopTurnAfterResult, true);
  assert.equal(results[2]?.success, false);
});

test("dependency execution order does not reorder model result declarations", async () => {
  const f = fixture(2);
  const tools = calls(["B", "A", "C"]);
  const schedule = new ToolScheduler().schedule(
    tools.map((tool) => ({
      toolCallId: tool.id,
      toolName: tool.name,
      dependsOn: tool.id === "B" ? ["A" as never] : [],
      readOnly: true,
      concurrentSafe: true,
      sideEffectScope: "none",
    })),
  );
  f.release();
  const generator = f.executor.executeSchedule(tools, schedule);
  let results;
  while (true) {
    const next = await generator.next();
    if (next.done) {
      results = next.value;
      break;
    }
  }
  assert.deepEqual(f.started, ["A", "C", "B"]);
  assert.deepEqual(
    results.map((result) => result.toolCallId),
    ["B", "A", "C"],
  );
});
