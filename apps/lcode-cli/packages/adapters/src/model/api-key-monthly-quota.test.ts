import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { FileSharedQuotaCoordinator } from "./api-key-shared-quota.js";
import { sharedFeedbackSchema } from "./api-key-shared-quota-state.js";
import { normalizeContentRefusalResponse } from "@lcode/provider-node";
import { readRateLimitHint, type SharedQuotaInput } from "@lcode/provider";

test("monthly reset survives shared API owner cold reload and cannot be bypassed by another key after 24 hours", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "monthly-shared-quota-"));
  t.after(async () => {
    const target = await realpath(directory);
    assert.ok(target.startsWith((await realpath(tmpdir())) + sep));
    await rm(target, { recursive: true, force: true });
  });
  let now = Date.now();
  const initialNow = now;
  const request = (id: string): SharedQuotaInput => ({
    providerId: "fixture",
    poolId: "pool",
    keyId: id,
    maxInFlight: 2,
    request: { attemptId: id, scopeKey: "workspace/session", modelKey: "model", createdAt: now },
    windows: [],
  });
  const firstOwner = new FileSharedQuotaCoordinator(directory, { now: () => now });
  const lease = await firstOwner.reserve(request("first"));
  await firstOwner.dispatch(lease);
  const at = new Date(now + 9 * 86400000).toISOString().slice(0, 19);
  const response = await normalizeContentRefusalResponse(
    Response.json(
      {
        error: {
          code: "AccountQuotaExceeded",
          message: `monthly usage quota. It will reset at ${at} UTC+0,`,
        },
      },
      { status: 429 },
    ),
  );
  const hint = readRateLimitHint(response.headers);
  await response.text();
  const feedback = sharedFeedbackSchema.parse({
    outcome: "failed",
    statusCode: 429,
    retryAfterMs: hint.delayMs,
    quotaResetAt: hint.resetAt,
    rateLimitScope: hint.scope,
  });
  await firstOwner.usage(lease, {}, undefined, feedback);
  await firstOwner.finish(lease);
  now = initialNow + 2 * 86400000;
  const cold = new FileSharedQuotaCoordinator(directory, { now: () => now });
  await assert.rejects(cold.reserve(request("another-key")), /route-cooling/);
  now = hint.resetAt! + 1;
  const probe = await cold.reserve(request("recovery-probe"));
  await cold.cancel(probe);
  assert.equal(
    sharedFeedbackSchema.safeParse({ statusCode: 429, retryAfterMs: 9 * 86400000 }).success,
    false,
  );
});
