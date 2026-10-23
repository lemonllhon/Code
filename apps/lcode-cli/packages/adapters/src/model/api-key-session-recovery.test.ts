import assert from "node:assert/strict";
import test from "node:test";
import { RateLimitWindow } from "@lcode/provider";
import { ApiKeyPool } from "./api-key-pool.js";
import { withApiKeyLease } from "./api-key-fetch.js";
import { classifyModelFailure } from "./failure-classifier.js";
import { classifyRoutingFailure } from "./failure-routing.js";
import { RoutingError } from "@lcode/provider";
import { ApiKeySharedQuotaClient } from "./api-key-shared-client.js";
import { FileSharedQuotaCoordinator } from "./api-key-shared-quota.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

for (const coordinated of [false, true])
  for (const cancellationRejects of [false, true])
    test(`SR-01/05 original session recovery follows physical cancellation (shared: ${coordinated}, rejects: ${cancellationRejects})`, async (t) => {
      let now = 0,
        posts = 0;
      const directory = await mkdtemp(join(tmpdir(), "session-recovery-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const client = new ApiKeySharedQuotaClient(
        new FileSharedQuotaCoordinator(directory, { now: () => now }),
      );
      const pool = new ApiKeyPool(
        [{ id: "fixture", apiKey: "synthetic", routing: { quotaPoolId: "team" } }],
        undefined,
        new RateLimitWindow(() => now),
        coordinated ? { providerId: "fixture", client } : undefined,
        () => now,
      );
      pool.configureRouting({ version: 1, strategy: "reliable-first" });
      const context = (id: string, signal?: AbortSignal) => ({
        attemptId: id,
        scopeKey: "original-session",
        turnId: id,
        modelKey: "model",
        workUnits: 1,
        signal,
      });
      try {
        const first = await pool.acquire(undefined, undefined, context("network"));
        await assert.rejects(
          withApiKeyLease(
            async () => {
              posts++;
              throw new TypeError("synthetic network interruption");
            },
            first,
            "openai-compatible",
          )("https://example.test/v1"),
          /network interruption/,
        );
        first.observeUsage!({ outcome: "failed" });
        first.release();
        await first.flushRouting?.();
        now = 1000;
        const controller = new AbortController();
        const probe = await pool.acquire(
          controller.signal,
          undefined,
          context("probe", controller.signal),
        );
        let completeCancellation!: () => void;
        const pending = new Promise<void>((resolve) => {
          completeCancellation = resolve;
        });
        const response = await withApiKeyLease(
          async () => {
            posts++;
            return new Response(
              new ReadableStream({
                cancel: async () => {
                  await pending;
                  if (cancellationRejects) throw new Error("synthetic cancellation unconfirmed");
                },
              }),
            );
          },
          probe,
          "openai-compatible",
        )("https://example.test/v1", { signal: controller.signal });
        controller.abort();
        const closing = response.body!.cancel();
        assert.throws(() => pool.reserve(context("before-end")), /route-cooling|concurrency-full/);
        completeCancellation();
        if (cancellationRejects) await assert.rejects(closing, /unconfirmed/);
        else await closing;
        probe.release();
        await probe.flushRouting?.();
        now = 86400000;
        if (cancellationRejects) {
          assert.throws(
            () => pool.reserve(context("still-unknown")),
            /route-cooling|concurrency-full/,
          );
          assert.equal(posts, 2, "unconfirmed termination cannot start another POST");
        } else {
          const next = await pool.acquire(undefined, undefined, context("same-session-again"));
          const result = await withApiKeyLease(
            async () => {
              posts++;
              return new Response("recovered");
            },
            next,
            "openai-compatible",
          )("https://example.test/v1");
          assert.equal(await result.text(), "recovered");
          next.observeUsage!({ outcome: "success" });
          next.release();
          await next.flushRouting?.();
          assert.equal(posts, 3, "only new, explicitly admitted attempts are sent");
        }
      } finally {
        pool.dispose();
      }
    });

test("SR-06 local recovery is a runtime reason while actual HTTP 429 retains rate-limited attribution", () => {
  const error = new RoutingError("route-cooling", {
    phase: "admission",
    dispatch: "unsent",
    recoveryState: "probing",
  });
  assert.equal(classifyModelFailure(error).reason, "route_cooling");
  assert.equal(classifyModelFailure(error).retryReason, "route_cooling");
  assert.equal(
    classifyRoutingFailure(
      new Error("synthetic HTTP rejection"),
      undefined,
      { "x-zcode-routing-reason": "route-cooling" },
      429,
    )!.reason,
    "rate_limited",
  );
});

test("SR-04 local concurrency, quota and policy gates do not emit upstream rate-limit retries", () => {
  for (const code of ["concurrency-full", "quota-exhausted", "policy-conflict"] as const) {
    const result = classifyModelFailure(
      new RoutingError(code, { phase: "admission", dispatch: "unsent" }),
    );
    assert.equal(result.reason, "routing_unavailable");
    assert.equal(result.retryReason, "routing_unavailable");
  }
});
