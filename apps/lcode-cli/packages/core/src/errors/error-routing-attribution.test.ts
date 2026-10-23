import assert from "node:assert/strict";
import test from "node:test";
import { errorAttributionSchema } from "@lcode/shared/lcode-protocol-v4";
import { projectExecutionErrorPayload } from "./error-payload.js";

test("SR-06 route state and retry exhaustion survive Core projection and strict protocol validation", () => {
  const routing = {
    code: "route-cooling",
    scope: "model",
    phase: "admission",
    dispatch: "unsent",
    recoveryState: "uncertain",
  };
  const error = Object.assign(new Error("Connection routing: route-cooling"), {
    context: {
      source: "runtime",
      reason: "route_cooling",
      routing,
      retryDisposition: "exhausted",
      retryBudgetExhausted: true,
      retryable: true,
    },
  });
  const projected = projectExecutionErrorPayload(error);
  const parsed = errorAttributionSchema.parse(projected.attribution);
  assert.deepEqual(parsed.routing, routing);
  assert.equal(parsed.retryDisposition, "exhausted");
  assert.equal(parsed.retryBudgetExhausted, true);
  assert.equal(parsed.source, "runtime");
  assert.equal(
    errorAttributionSchema.safeParse({ routing: { ...routing, apiKey: "synthetic" } }).success,
    false,
  );
});
