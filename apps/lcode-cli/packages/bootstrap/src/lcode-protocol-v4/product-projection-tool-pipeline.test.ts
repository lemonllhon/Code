import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@lcode/contracts";
import { ToolRegistryImpl, createToolExecutor, type ToolEntry } from "@lcode/core";
import {
  applyConversationDeltas,
  type ConversationSnapshot,
} from "@lcode/shared/lcode-protocol-v4";
import { ProductProjection } from "./product-projection.js";

const tick = () => new Promise<void>((done) => setImmediate(done));
for (const deliveryKind of ["desktop-continuous", "web-remote-replayable"] as const) {
  test(`${deliveryKind}: shared permits project queued/running/refill/stop and snapshot recovery`, async () => {
    const owner = new ProductProjection("fixture", "epoch");
    let client: ConversationSnapshot = structuredClone(owner.getSnapshot());
    let seq = 0;
    const emit = async (raw: Partial<SessionEvent>) => {
      const event = {
        id: `event-${++seq}`,
        sessionId: "fixture",
        traceId: "trace",
        turnId: "turn",
        timestamp: new Date(seq * 10),
        ...raw,
        sequenceNumber: seq,
      } as SessionEvent;
      const deltas = owner.applyEvent(event);
      client = { ...applyConversationDeltas(client, deltas), seq };
      assert.deepEqual(client, owner.getSnapshot());
    };
    await emit({
      type: SessionEventType.TurnStarted,
      payload: { turnNumber: 1, messageId: "user", input: "fixture" },
    });
    const calls = Array.from({ length: 12 }, (_, i) => ({
      id: `read-${i}`,
      name: "Read",
      input: {},
    }));
    for (const tool of calls)
      await emit({
        type: SessionEventType.ToolCallScheduled,
        payload: {
          toolCallId: tool.id,
          toolName: tool.name,
          assistantMessageId: "assistant",
          input: {},
          dependencies: [],
          parallelGroupIndex: 0,
          canRunParallel: true,
          schedule: {
            parallelGroups: [calls.map((call) => call.id)],
            executionOrder: calls.map((call) => call.id),
          },
        },
      });
    const releases = new Map<string, () => void>();
    const registry = new ToolRegistryImpl();
    registry.register({
      capability: "Controlled read fixture",
      metadata: {
        name: "Read",
        description: "Controlled read fixture",
        readOnly: true,
        concurrentSafe: true,
        needsApproval: false,
        destructive: false,
        sideEffectScope: "none",
        riskLevel: "low",
        timeoutMs: 60_000,
        maxOutputBytes: 1024,
      },
      permission: {
        permission: "read",
        reason: "fixture",
        riskLevel: "low",
        sideEffectScope: "none",
        needsApproval: false,
        patternSources: [],
        alwaysAllowPatternSources: [],
        denyPriority: "beforeAsk",
      },
      timeout: { defaultMs: 60_000, maxMs: 60_000, allowCallOverride: false },
      cancellation: {
        supported: true,
        cleanup: "required",
        userVisibleMessage: "fixture cancelled",
      },
      resultBudget: {
        maxInlineBytes: 1024,
        maxModelBytes: 1024,
        strategy: "truncate",
        preview: { maxBytes: 1024, direction: "head" },
      },
      trace: {
        required: true,
        propagateToAdapters: true,
        recordInput: "summary",
        recordOutput: "summary",
      },
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      handler: async (_input, context) => {
        await new Promise<void>((done) => releases.set(context.toolCallId, done));
        return {};
      },
    } satisfies ToolEntry);
    const executor = createToolExecutor({
      registry,
      maxConcurrency: 2,
      sessionId: "fixture" as never,
      turnId: "turn" as never,
      emitEvent: emit,
      permissionService: { checkPermission: () => ({ allowed: true, decision: "allow" }) } as never,
      getMode: () => "yolo",
      deliveryKind,
    });
    const abort = new AbortController();
    const pending = executor.executeBatch(calls as never, { signal: abort.signal });
    const count = (status: string) =>
      client.rows.window.filter((row) => row.kind === "toolCall" && row.status === status).length;
    try {
      await tick();
      assert.equal(count("running"), 2);
      assert.equal(count("inputStreaming"), 10);
      // replayable 在等待和运行时都可从 owner snapshot 重接；不重建执行器或重跑 handler。
      if (deliveryKind === "web-remote-replayable") client = structuredClone(owner.getSnapshot());
      releases.get("read-1")!();
      await tick();
      assert.ok(releases.has("read-2"));
      assert.equal(count("running"), 2);
      assert.equal(count("success"), 1);
      if (deliveryKind === "web-remote-replayable") client = structuredClone(owner.getSnapshot());
      abort.abort();
      const results = await pending;
      assert.deepEqual(
        results.map((result) => result.toolCallId),
        calls.map((call) => call.id),
      );
      assert.equal(count("success"), 1);
      assert.equal(count("cancelled"), 11);
      assert.equal(releases.size, 3);
      const stopped = structuredClone(owner.getSnapshot());
      releases.forEach((release) => release());
      await tick();
      assert.deepEqual(owner.getSnapshot(), stopped);
    } finally {
      abort.abort();
      releases.forEach((release) => release());
      await pending;
    }
  });
}
