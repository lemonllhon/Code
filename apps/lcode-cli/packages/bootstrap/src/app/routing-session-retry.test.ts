import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionEventType,
  ModelRetryReason,
  createTraceId,
  createModelProviderId,
  createModelId,
  type ModelNetworkStatusEvent,
  type SessionEvent,
} from "@lcode/contracts";
import { getWorkflowConcurrencyGovernor } from "./workflow-concurrency-governor.js";
import { ProductProjection } from "../lcode-protocol-v4/product-projection.js";

test("SR-04 local routing waits leave shared concurrency and other sessions intact; real 429 still throttles", async (t) => {
  t.mock.method(Date, "now", () => 1000);
  const governor = getWorkflowConcurrencyGovernor();
  const status = (
    type: "model_request_completed" | "model_retry_scheduled",
    reason: ModelRetryReason = ModelRetryReason.RouteCooling,
  ): ModelNetworkStatusEvent => {
    const base = {
      timestamp: new Date(1000).toISOString(),
      traceId: createTraceId(),
      requestId: "fixture",
      providerId: createModelProviderId("fixture"),
      modelId: createModelId("fixture"),
      transport: "http" as const,
      attempt: 1,
      maxAttempts: 2,
    };
    return type === "model_request_completed"
      ? { ...base, type, durationMs: 1 }
      : {
          ...base,
          type,
          reason,
          delayMs: 100,
          nextAttempt: 2,
          retryAfterMs: 100,
          message: "synthetic",
        };
  };
  const key = "sr-routing-wait/model";
  const seed = governor.tryAdmit("original-session", key)!;
  await seed.publish(status("model_request_completed"));
  const before = governor.snapshot(key)!;
  for (const reason of ["route_cooling", "routing_unavailable"] as const) {
    const local = governor.tryAdmit("original-session", key)!;
    await local.publish(status("model_retry_scheduled", reason));
    const after = governor.snapshot(key)!;
    assert.equal(after.cap, before.cap);
    assert.equal(after.epoch, before.epoch);
    assert.equal(after.cooldownUntil, before.cooldownUntil);
    assert.equal(after.successStreak, before.successStreak);
  }
  const other = governor.tryAdmit("other-session", key);
  assert.ok(other, "another session must still acquire its slot");
  other.release();
  const real = governor.tryAdmit("real-provider", "sr-real-429/model")!;
  await real.publish(status("model_retry_scheduled", "rate_limited"));
  assert.equal(governor.tryAdmit("other-session", "sr-real-429/model"), undefined);
});

test("SR-06 routing retry stays a runtime reason in live and cold-restored projection", () => {
  const event = (type: SessionEvent["type"], payload: unknown, sequenceNumber: number) =>
    ({
      id: `event-${sequenceNumber}`,
      sessionId: "fixture",
      turnId: "turn",
      traceId: "trace",
      timestamp: new Date(sequenceNumber),
      type,
      payload,
      sequenceNumber,
    }) as SessionEvent;
  const facts = [
    event(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "synthetic", messageId: "user" },
      1,
    ),
    event(
      SessionEventType.ModelNetworkStatus,
      {
        type: "model_retry_scheduled",
        attempt: 1,
        maxAttempts: 2,
        delayMs: 100,
        reason: "route_cooling",
        querySource: "main_turn",
      },
      2,
    ),
  ];
  for (const cold of [false, true]) {
    const projection = new ProductProjection("fixture", "epoch");
    if (cold) projection.beginHydrationReplay();
    for (const fact of facts) {
      if (cold) projection.applyHydrationEvent(fact);
      else projection.applyEvent(fact);
    }
    if (cold) projection.completeHydrationReplay();
    assert.equal(
      projection.getSnapshot().control.apiRetry?.reasonCode,
      "fault.runtime.routeCooling",
    );
  }
});
