import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGoogleQuotaResponse } from "./google-quota-error.js";
import { record } from "./common.js";
test("known individual quota exhaustion becomes terminal without changing HTTP status", async () => {
  for (const error of [
    { code: 429, message: "Individual quota reached. Resets in 167h 59m" },
    {
      code: 429,
      message: "fixture",
      details: [
        { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "DAILY_QUOTA_EXCEEDED" },
      ],
    },
  ]) {
    const response = await normalizeGoogleQuotaResponse(
      Response.json(
        { error },
        { status: 429, headers: { "retry-after": "3600", "x-request-id": "fixture" } },
      ),
    );
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("x-request-id"), "fixture");
    assert.equal(response.headers.get("retry-after"), "3600");
    assert.equal(record(record(await response.json()).error).code, "exceeded_current_quota_error");
  }
});
test("unknown 429 and temporary limits retain their existing classification and body", async () => {
  for (const error of [
    { code: 429, message: "Too many requests" },
    { code: 429, details: [{ reason: "RATE_LIMIT_EXCEEDED" }] },
  ]) {
    const response = Response.json({ error }, { status: 429 });
    const normalized = await normalizeGoogleQuotaResponse(response);
    assert.equal(normalized, response);
    assert.deepEqual(await response.json(), { error });
  }
});
