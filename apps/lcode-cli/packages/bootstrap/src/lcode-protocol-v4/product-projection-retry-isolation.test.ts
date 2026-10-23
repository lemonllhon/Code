import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@lcode/contracts";
import { conversationTopicFrameSchema } from "@lcode/shared/lcode-protocol-v4";
import { ProductProjection } from "./product-projection.js";
import { ConversationV4Gateway } from "./v4-gateway.js";

for (const cold of [false, true])
  for (const source of ["other-session", "session_title", "project_memory_extract"])
    test(`SR-11 retry isolation: cold=${cold}, source=${source}`, () => {
      const projection = new ProductProjection("fixture", "epoch");
      let sequenceNumber = 0;
      if (cold) projection.beginHydrationReplay();
      const apply = (type: SessionEvent["type"], payload: unknown, sessionId = "fixture") => {
        const event = {
          id: `event-${++sequenceNumber}`,
          sessionId,
          traceId: "trace",
          turnId: "turn",
          timestamp: new Date(sequenceNumber),
          sequenceNumber,
          type,
          payload,
        } as SessionEvent;
        if (cold) projection.applyHydrationEvent(event);
        else projection.applyEvent(event);
      };
      apply(SessionEventType.TurnStarted, { turnNumber: 1, input: "synthetic", messageId: "user" });
      const retry = {
        type: "model_retry_scheduled",
        attempt: 5,
        maxAttempts: 11,
        delayMs: 100,
        reason: "network_error",
        requestId: "foreground",
        querySource: "subagent",
      };
      const foreignSession = source === "other-session" ? "other" : "fixture";
      const querySource = source === "other-session" ? "subagent" : source;
      apply(SessionEventType.ModelNetworkStatus, { ...retry, querySource }, foreignSession);
      assert.equal(projection.getSnapshot().control.apiRetry, null);
      apply(SessionEventType.ModelNetworkStatus, retry);
      const ownRetry = structuredClone(projection.getSnapshot().control.apiRetry);
      assert.equal(ownRetry?.attempt, 5);
      for (const type of [
        "model_request_started",
        "model_request_completed",
        "model_request_failed",
      ])
        apply(
          SessionEventType.ModelNetworkStatus,
          { type, attempt: 1, retryable: false, requestId: "foreign", querySource },
          foreignSession,
        );
      assert.deepEqual(projection.getSnapshot().control.apiRetry, ownRetry);
      if (cold) projection.completeHydrationReplay();
    });

for (const clientMode of ["desktop-continuous", "web-remote-replayable"] as const)
  test(`SR-11 gateway: concurrent independent / detached child snapshots and recovery (${clientMode})`, async () => {
    const gateway = new ConversationV4Gateway(
      {
        sessionExists: (id) => id !== "child",
        emitWireFrame() {},
        executeCommand: async () => undefined,
      },
      { now: () => 1000, createLogEpoch: () => "epoch" },
    );
    const sessions = ["parent", "independent", "child"];
    const event = (
      sessionId: string,
      sequenceNumber: number,
      type: SessionEvent["type"],
      payload: unknown,
    ) =>
      ({
        id: `${sessionId}-${sequenceNumber}`,
        sessionId,
        traceId: "trace",
        turnId: `turn-${sessionId}`,
        timestamp: new Date(sequenceNumber),
        sequenceNumber,
        type,
        payload,
      }) as SessionEvent;
    const ingest = (fact: SessionEvent) => {
      if (String(fact.sessionId) === "child")
        gateway.ingestDetachedLiveSession("child", fact, "parent");
      else gateway.ingest(String(fact.sessionId), fact);
    };
    try {
      for (const [index, id] of sessions.entries()) {
        ingest(
          event(id, 1, SessionEventType.TurnStarted, {
            turnNumber: 1,
            input: "synthetic",
            messageId: `${id}-user`,
          }),
        );
        ingest(
          event(id, 2, SessionEventType.ModelNetworkStatus, {
            type: "model_retry_scheduled",
            querySource: id === "child" ? "subagent" : "main_turn",
            attempt: 5 + index * 2,
            maxAttempts: 11,
            delayMs: 100,
            reason: "network_error",
            requestId: `${id}-request`,
          }),
        );
      }
      const subscriptions = [];
      for (const [index, id] of sessions.entries()) {
        const subscribed = await gateway.subscribe({
          topic: `conversation/${id}`,
          connectionId: "view",
          clientMode,
        });
        const frame = subscribed.initialFrame!;
        assert.equal(frame.payload.kind, "snapshot");
        if (frame.payload.kind !== "snapshot") throw new Error("expected initial snapshot");
        assert.equal(frame.payload.snapshot.control.apiRetry?.attempt, 5 + index * 2);
        subscriptions.push({ id, subscriptionId: subscribed.ack.subscriptionId });
      }
      ingest(
        event("child", 3, SessionEventType.ModelNetworkStatus, {
          type: "model_request_completed",
          querySource: "subagent",
          requestId: "child-request",
          attempt: 1,
        }),
      );
      for (const [index, { id, subscriptionId }] of subscriptions.entries()) {
        const recovery = gateway.resyncReserved({
          topic: `conversation/${id}`,
          connectionId: "view",
          subscriptionId,
          base: null,
        });
        const frame = conversationTopicFrameSchema.parse(recovery.initialFrame);
        assert.equal(frame.payload.kind, "snapshot");
        if (frame.payload.kind !== "snapshot") throw new Error("expected recovery snapshot");
        assert.equal(frame.payload.snapshot.control.phase, "running");
        assert.equal(
          frame.payload.snapshot.control.apiRetry?.attempt ?? null,
          id === "child" ? null : 5 + index * 2,
        );
        assert.ok(recovery.initialWires.every((wire) => wire.deliveryKind === "recovery"));
        assert.equal(recovery.commit(), true);
      }
    } finally {
      gateway.dispose();
    }
  });
