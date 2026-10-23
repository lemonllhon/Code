import assert from "node:assert/strict";
import test from "node:test";
import { sessionErrorInfoSchema } from "./snapshot.js";
import { lcodeProtocolErrorDetailSchema } from "../lcode-protocol/index.js";

const attribution = {
  source: "runtime",
  reason: "route_cooling",
  retryable: true,
  routing: {
    code: "route-cooling",
    scope: "model",
    phase: "admission",
    dispatch: "unsent",
    recoveryState: "uncertain",
  },
  retryDisposition: "exhausted",
  retryBudgetExhausted: true,
};

test("SR-06 continuous error and replayable snapshot preserve the same routing facts through JSON", () => {
  const continuous = lcodeProtocolErrorDetailSchema.parse(
    JSON.parse(
      JSON.stringify({
        type: "ModelError",
        message: "Connection routing: route-cooling",
        attribution,
      }),
    ),
  );
  const snapshot = sessionErrorInfoSchema.parse(
    JSON.parse(
      JSON.stringify({
        code: "model_request_failed",
        message: continuous.message,
        recoverable: true,
        source: "runtime",
        at: Date.parse("2026-01-01T00:00:00.000Z"),
        attribution: continuous.attribution,
      }),
    ),
  );
  assert.deepEqual(snapshot.attribution, attribution);
  assert.deepEqual(continuous.attribution, attribution);
});

test("SR-06 old errors remain valid and untrusted recovery metadata cannot cross the protocol", () => {
  assert.ok(
    lcodeProtocolErrorDetailSchema.safeParse({ type: "ModelError", message: "old error" }).success,
  );
  for (const routing of [
    { ...attribution.routing, recoveryState: "healthy-from-client" },
    { ...attribution.routing, apiKey: "synthetic" },
    { ...attribution.routing, retryAt: -1 },
  ])
    assert.equal(
      lcodeProtocolErrorDetailSchema.safeParse({
        type: "ModelError",
        message: "bad error",
        attribution: { ...attribution, routing },
      }).success,
      false,
    );
});
