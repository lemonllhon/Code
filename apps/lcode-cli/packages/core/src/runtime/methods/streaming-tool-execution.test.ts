import assert from "node:assert/strict";
import test from "node:test";
import type { MessagePart, Model, ToolCall } from "@lcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ExecuteToolsOptions } from "../types.js";
import { ToolRegistryImpl } from "../../tool/registry.js";
import { ToolScheduler, type ToolSchedule } from "../../tool/scheduler.js";
import { createToolExecutor } from "../../tool/executor/impl.js";
import type { ToolEntry, ToolExecutionContext } from "../../tool/types.js";
import { createStreamingToolCoordinator } from "./streaming-tool-coordinator.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";

const tick = () => new Promise<void>((done) => setImmediate(done));
function fixture(block = false) {
  const registry = new ToolRegistryImpl(),
    scheduler = new ToolScheduler();
  const started: string[] = [],
    parts: MessagePart[] = [];
  const contexts: ToolExecutionContext[] = [];
  let release!: () => void;
  const pending = new Promise<void>((done) => {
    release = done;
  });
  for (const name of ["Read", "Write"])
    registry.register({
      metadata: {
        name,
        readOnly: name === "Read",
        concurrentSafe: name === "Read",
        destructive: false,
        needsApproval: false,
        sideEffectScope: name === "Read" ? "none" : "workspace",
        riskLevel: "low",
      },
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      handler: async (_input, context) => {
        started.push(context.toolCallId);
        contexts.push(context);
        if (block) await pending;
        return {};
      },
    } as ToolEntry);
  const executor = createToolExecutor({
    registry,
    maxConcurrency: 2,
    sessionId: "fixture" as never,
    permissionService: { checkPermission: () => ({ allowed: true, decision: "allow" }) } as never,
    emitEvent: async () => {},
    getMode: () => "yolo",
  });
  const runtime = {
    sessionId: "fixture",
    config: { modelStreaming: "on" },
    registry,
    persistPart: async (part: MessagePart) => {
      parts.push(part);
    },
    appendEvent: async () => {},
    createEvent: (type: string, payload: unknown) => ({ type, payload }),
    scheduleTools: async (calls: ToolCall[]) =>
      scheduler.schedule(
        calls.map((c) => ({
          toolCallId: c.id,
          toolName: c.name,
          dependsOn: [],
          ...registry.getMetadata(c.name),
        })),
      ),
    emitToolScheduledEvents: async () => [],
    executeTools: async (
      calls: ToolCall[],
      schedule: ToolSchedule,
      options?: ExecuteToolsOptions,
    ) => {
      const generator = executor.executeSchedule(calls, schedule, options);
      while (true) {
        const next = await generator.next();
        if (next.done) return { results: next.value, events: [] };
      }
    },
  } as unknown as AgentRuntimeInternal;
  const state = {
    turnAbortSignal: new AbortController().signal,
    turnTraceContext: {},
    events: [],
  } as unknown as RegularTurnLoopState;
  const coordinator = createStreamingToolCoordinator(runtime, state, {
    assistantMessageId: "message" as never,
    model: { providerId: "fixture", modelId: "fixture", options: {} } as Model,
    traceContext: {},
  });
  return { coordinator, started, parts, release, contexts, state };
}

test("during-stream execution carries the trusted automation identity into the handler", async () => {
  const f = fixture();
  f.state.automationId = "automation-self";
  const call = { id: "streamed-call", name: "Read", input: {} };
  f.coordinator.accept(call);
  const results = await f.coordinator.drain([call]);
  assert.equal(results.length, 1);
  assert.equal(f.contexts[0]?.automationTurn, true);
  assert.equal(f.contexts[0]?.automationId, "automation-self");
});

for (const names of [
  ["Write", "Read"],
  ["Read", "Write", "Read"],
]) {
  test(`streaming preserves the ${names.join(" -> ")} barrier`, async () => {
    const f = fixture();
    const calls = names.map((name, i) => ({ id: `call-${i}`, name, input: {} }));
    calls.forEach((call) => f.coordinator.accept(call));
    await tick();
    assert.deepEqual(f.started, names[0] === "Read" ? ["call-0"] : []);
    const results = await f.coordinator.drain(calls);
    assert.equal(results.length, names[0] === "Read" ? 1 : 0);
  });
}

test("twelve streamed calls share actual executor permits and only admitted tools become running", async () => {
  const f = fixture(true);
  const calls = Array.from({ length: 12 }, (_, i) => ({
    id: `call-${i}`,
    name: "Read",
    input: {},
  }));
  calls.forEach((call) => f.coordinator.accept(call));
  f.coordinator.accept(calls[0]!);
  try {
    await tick();
    assert.equal(f.started.length, 2);
    assert.equal(
      f.parts.filter((p) => p.type === "tool" && p.state.status === "running").length,
      2,
    );
    assert.equal(
      f.parts.filter((p) => p.type === "tool" && p.state.status === "pending").length,
      12,
    );
  } finally {
    f.release();
  }
  const results = await f.coordinator.drain(calls);
  assert.equal(results.length, 12);
  assert.equal(new Set(f.started).size, 12);
  f.coordinator.accept({ id: "late", name: "Read", input: {} });
  await tick();
  assert.equal(f.started.length, 12);
});
