import assert from "node:assert/strict";
import test from "node:test";
import { ApiKeyPool } from "./api-key-pool.js";
import { withApiKeyLease, createApiKeyFailoverFetch } from "./api-key-fetch.js";

for (const providerKind of ["openai", "anthropic", "openai-compatible"])
  for (const code of [
    "content_filter",
    "content_policy_rejected",
    "content_policy_violation",
    "cyber_policy",
    "bio_policy",
  ])
    test(`${providerKind} ${code} does not disable or rotate API keys`, async () => {
      const keys = [
        { id: "a", apiKey: "fixture-a", enabled: true },
        { id: "b", apiKey: "fixture-b", enabled: true },
      ];
      const pool = new ApiKeyPool(keys);
      let calls = 0;
      const fetch: typeof globalThis.fetch = async () => {
        calls++;
        return new Response(JSON.stringify({ error: { code, message: "fixture refusal" } }), {
          status: 403,
        });
      };
      const lease = pool.reserve();
      const res = await withApiKeyLease(
        fetch,
        lease,
        providerKind,
      )("https://fixture.invalid", { method: "POST" });
      assert.equal(res.status, 400);
      await res.text();
      lease.release();
      assert.equal(lease.canRotate, false);
      assert.equal(pool.availableCount, 2);
      const legacy = createApiKeyFailoverFetch({ fetch, pool, keys, providerKind });
      await (await legacy("https://fixture.invalid", { method: "POST" })).text();
      assert.equal(calls, 2);
      assert.equal(pool.availableCount, 2);
      pool.dispose();
    });
