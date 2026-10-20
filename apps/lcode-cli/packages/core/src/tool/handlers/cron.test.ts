import assert from "node:assert/strict";
import test from "node:test";
import type { AutomationPort, AutomationExecutionContext } from "@lcode/contracts";
import { createToolExecutor } from "../executor/impl.js";
import { ToolRegistryImpl } from "../registry.js";
import { ToolScheduler } from "../scheduler.js";
import type { ToolExecutionContext } from "../types.js";
import { cronCreateToolEntry, cronDeleteToolEntry, cronUpdateToolEntry } from "./cron.js";

const ownId = "automation-self";
const otherId = "automation-other";

function fixture() {
  const deleted: string[] = [];
  const executions: (AutomationExecutionContext | undefined)[] = [];
  let present = true;
  const port: AutomationPort = {
    create: async () => {
      throw new Error("must not create");
    },
    update: async () => {
      throw new Error("must not update");
    },
    list: async () => [],
    delete: async ({ id }, execution) => {
      deleted.push(id);
      executions.push(execution);
      const result = present;
      present = false;
      return result;
    },
  };
  const registry = new ToolRegistryImpl();
  registry.register(cronDeleteToolEntry);
  const executor = createToolExecutor({
    registry,
    sessionId: "session-fixture" as never,
    automationPort: port,
    permissionService: { checkPermission: () => ({ allowed: true, decision: "allow" }) } as never,
    emitEvent: async () => {},
    getMode: () => "yolo",
  });
  const context = {
    automationTurn: true,
    automationId: ownId,
    automationPort: port,
  } as unknown as ToolExecutionContext;
  return { context, deleted, executor, executions };
}

test("automation can delete itself repeatedly through the scheduled executor path", async () => {
  const f = fixture();
  const calls = [0, 1].map((n) => ({ id: `call-${n}`, name: "CronDelete", input: { id: ownId } }));
  const schedule = new ToolScheduler().schedule(
    calls.map((call) => ({
      toolCallId: call.id,
      toolName: call.name,
      dependsOn: [],
      ...cronDeleteToolEntry.metadata,
    })),
  );
  const generator = f.executor.executeSchedule(calls, schedule, {
    automationTurn: true,
    automationId: ownId,
  });
  let results;
  while (true) {
    const step = await generator.next();
    if (step.done) {
      results = step.value;
      break;
    }
  }
  assert.deepEqual(
    results.map((r) => r.success),
    [true, true],
  );
  assert.deepEqual(
    results.map((r) => (r.output as { deleted: boolean }).deleted),
    [true, false],
  );
  assert.deepEqual(f.deleted, [ownId, ownId]);
  assert.deepEqual(f.executions, [
    { automationTurn: true, automationId: ownId },
    { automationTurn: true, automationId: ownId },
  ]);
});

test("automation cannot delete a different automation even in the same workspace", async () => {
  const f = fixture();
  const result = await f.executor.execute(
    { id: "call", name: "CronDelete", input: { id: otherId } },
    {
      automationTurn: true,
      automationId: ownId,
    },
  );
  assert.equal(result.success, false);
  assert.deepEqual(f.deleted, []);
});

test("an automation boolean without a trusted id grants no deletion permission", async () => {
  const f = fixture();
  const context = { ...f.context, automationId: undefined };
  await assert.rejects(cronDeleteToolEntry.handler({ id: ownId }, context), /only delete itself/i);
  assert.deepEqual(f.deleted, []);
});

test("a trusted automation id remains restrictive even when the boolean is absent", async () => {
  const f = fixture();
  await assert.rejects(
    cronDeleteToolEntry.handler(
      { id: otherId },
      {
        ...f.context,
        automationTurn: undefined,
      },
    ),
    { type: "permission_denied", recoverable: false, retryable: false },
  );
  assert.deepEqual(f.deleted, []);
});

test("model input cannot replace the executor's automation identity", async () => {
  const f = fixture();
  const result = await f.executor.execute(
    {
      id: "forged-call",
      name: "CronDelete",
      input: { id: otherId, automationId: otherId },
    },
    { automationTurn: true, automationId: ownId },
  );
  assert.equal(result.success, false);
  assert.deepEqual(f.deleted, []);
});

test("automation create and update remain forbidden before the port", async () => {
  const f = fixture();
  for (const entry of [cronCreateToolEntry, cronUpdateToolEntry]) {
    await assert.rejects(entry.handler({}, f.context), /not allowed while running/i);
  }
});

test("ordinary user turns retain deletion permission", async () => {
  const f = fixture();
  await cronDeleteToolEntry.handler(
    { id: otherId },
    {
      ...f.context,
      automationTurn: false,
      automationId: undefined,
    },
  );
  assert.deepEqual(f.deleted, [otherId]);
  assert.deepEqual(f.executions, [{ automationTurn: false, automationId: undefined }]);
});
