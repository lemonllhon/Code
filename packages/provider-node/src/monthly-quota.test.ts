import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContentRefusalResponse } from "./content-refusal.js";
import { readRateLimitHint } from "@lcode/provider";

test("shared API/OAuth observation preserves monthly error/body and publishes a bounded reset", async () => {
  const reset = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 19).replace("T", " ");
  const body = {
    error: {
      code: "AccountQuotaExceeded",
      message: `monthly usage quota. It will reset at ${reset} UTC+0,`,
    },
  };
  const original = Response.json(body, { status: 429 });
  const response = await normalizeContentRefusalResponse(original);
  assert.equal(response.status, 429);
  assert.ok(readRateLimitHint(response.headers).delayMs > 8 * 86400000);
  assert.equal(readRateLimitHint(response.headers).scope, "provider");
  assert.deepEqual(await response.json(), body);
});
test("malformed and oversized errors remain readable and do not create a long cooldown", async () => {
  for (const text of [
    "not-json",
    "x".repeat(70000),
    JSON.stringify({
      error: { message: "monthly usage quota reset at 2026-10-31 23:59:59 UTC+8," },
    }),
  ]) {
    const original = new Response(text, { status: 429 });
    const response = await normalizeContentRefusalResponse(original);
    assert.equal(response, original);
    assert.equal(response.headers.has("x-lcode-quota-reset-at"), false);
    assert.equal(await response.text(), text);
  }
});
