import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import type { SharedQuotaInput } from "@lcode/provider";
import { ApiKeyPool } from "./api-key-pool-owner.js";
import { FileSharedQuotaCoordinator } from "./api-key-shared-quota.js";
import { waitForSharedApiKeyCapacity } from "./api-key-shared-capacity.js";
import { apiKeyAdmissionRequest } from "./api-key-acquisition.js";

test("capacity wait cancellation/disposal only affects its waiter; physical end admits the next", async (t) => {
  const pool = new ApiKeyPool([{ id: "fixture", apiKey: "synthetic" }]);
  pool.configureRouting({ version: 1, strategy: "reliable-first" });
  t.after(() => pool.dispose());
  const first = await pool.acquire(undefined, undefined, { scopeKey: "first", attemptId: "first" });
  first.begin!();
  const controller = new AbortController();
  const outside = Promise.withResolvers<void>();
  const waiting = pool.acquire(
    controller.signal,
    async (wait) => {
      outside.resolve();
      await wait();
    },
    { scopeKey: "waiting", attemptId: "waiting" },
  );
  const cancelled = assert.rejects(waiting, /cancel fixture/);
  await outside.promise;
  assert.equal(pool.activeLeaseCount, 1);
  controller.abort(new Error("cancel fixture"));
  await cancelled;
  assert.equal(pool.readRoutingDiagnostics().items[0]!.inFlight, 1);
  const nextOutside = Promise.withResolvers<void>();
  const next = pool.acquire(
    undefined,
    async (wait) => {
      nextOutside.resolve();
      await wait();
    },
    { scopeKey: "next", attemptId: "next" },
  );
  await nextOutside.promise;
  first.release();
  await immediate();
  assert.equal(
    pool.readRoutingDiagnostics().items[0]!.inFlight,
    1,
    "consumer release does not prove physical termination",
  );
  first.end!(true);
  const lease = await next;
  lease.release();
  const held = await pool.acquire();
  held.begin!();
  const disposed = assert.rejects(pool.acquire(), /disposed/);
  pool.dispose();
  await disposed;
});

test("admission identity changes only after an unsent rejection and retains invocation boundaries", () => {
  const signal = new AbortController().signal;
  const original = {
    scopeKey: "remote-attachment",
    attemptId: "physical-one",
    createdAt: 10,
    deadline: 20,
    modelKey: "model",
    signal,
  };
  assert.equal(apiKeyAdmissionRequest(original, 0), original);
  assert.deepEqual(apiKeyAdmissionRequest(original, 1), {
    ...original,
    attemptId: "physical-one:admission:1",
  });
  assert.notEqual(
    apiKeyAdmissionRequest(original, 2)!.attemptId,
    apiKeyAdmissionRequest(original, 1)!.attemptId,
  );
});

const input = (attemptId: string, createdAt = Date.now()): SharedQuotaInput => ({
  providerId: "fixture",
  poolId: "team",
  keyId: "fixture",
  maxInFlight: 1,
  request: { attemptId, scopeKey: "fixture", createdAt },
  windows: [],
});

test("shared hard quota rejection cannot turn into a capacity wait", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "capacity-quota-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const owner = new FileSharedQuotaCoordinator(directory);
  const value = {
    ...input("first"),
    request: { ...input("first").request, tokens: { total: 60, quality: "bound" as const } },
    windows: [
      {
        resourceId: "tokens",
        instanceId: "one",
        revision: 1,
        kind: "budget" as const,
        quality: "fresh" as const,
        unit: "tokens",
        remaining: 100,
        limit: 100,
      },
    ],
  };
  const lease = await owner.reserve(value);
  await owner.dispatch(lease);
  await assert.rejects(
    owner.reserve({ ...value, request: { ...value.request, attemptId: "blocked" } }),
    (error: unknown) => (error as { code?: string }).code === "quota-exhausted",
  );
  await owner.finish(lease, "cancelled");
});

test(
  "shared capacity rechecks a release before subscribe and only expires unsent reservations",
  { timeout: 10_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "capacity-owner-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let offset = 0;
    const owner = new FileSharedQuotaCoordinator(directory, { now: () => Date.now() + offset });
    const controller = new AbortController();
    t.after(() => controller.abort());
    const capacity = { providerId: "fixture", poolId: "team", keyId: "fixture", maxInFlight: 1 };
    const lease = await owner.reserve(input("released"));
    await owner.cancel(lease);
    await owner.waitForCapacity(capacity, controller.signal);
    const expiring = await owner.reserve(input("expires", Date.now() - 29_900));
    await owner.waitForCapacity(capacity, controller.signal);
    const next = await owner.reserve(input("next"));
    assert.ok(next.sequence > expiring.sequence);
    await owner.dispatch(next);
    offset = 120_000;
    const cancelledController = new AbortController();
    const waiting = owner.waitForCapacity(capacity, cancelledController.signal);
    const cancelled = assert.rejects(waiting, /cancel shared fixture/);
    await immediate();
    cancelledController.abort(new Error("cancel shared fixture"));
    await cancelled;
    assert.equal((await owner.inspect("fixture", "team")).inFlight, 1);
    await owner.finish(next, "cancelled");
    await owner.waitForCapacity(capacity, controller.signal);
  },
);

test(
  "capacity watcher cancels during a locked read and propagates owner failure",
  { timeout: 10_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "capacity-read-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const controller = new AbortController();
    t.after(() => controller.abort());
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const waiting = waitForSharedApiKeyCapacity({
      directory,
      filename: "pool.json",
      signal: controller.signal,
      now: Date.now,
      read: async () => {
        entered.resolve();
        await release.promise;
        return { available: true };
      },
    });
    await entered.promise;
    controller.abort(new Error("cancel read fixture"));
    await assert.rejects(waiting, /cancel read fixture/);
    release.resolve();
    await assert.rejects(
      waitForSharedApiKeyCapacity({
        directory,
        filename: "pool.json",
        signal: new AbortController().signal,
        now: Date.now,
        read: async () => {
          throw new Error("fixture read failure");
        },
      }),
      (error: unknown) => (error as { code?: string }).code === "quota-owner-unavailable",
    );
  },
);

test(
  "another process releases shared capacity without model retry or polling",
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "capacity-process-"));
    const child = fork(
      new URL("./api-key-capacity-owner.fixture.ts", import.meta.url),
      [directory],
      {
        execArgv: ["--import", "tsx"],
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    let errors = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    const closed = once(child, "exit");
    const controller = new AbortController();
    t.after(async () => {
      controller.abort();
      if (child.exitCode === null) child.kill();
      await closed;
      await rm(directory, { recursive: true, force: true });
    });
    assert.deepEqual((await once(child, "message"))[0], "ready", errors);
    const owner = new FileSharedQuotaCoordinator(directory);
    await assert.rejects(owner.reserve(input("blocked")), /concurrency-full/);
    const waiting = owner.waitForCapacity(
      { providerId: "fixture", poolId: "team", keyId: "fixture", maxInFlight: 1 },
      controller.signal,
    );
    child.send("finish");
    await waiting;
    const lease = await owner.reserve(input("after-process"));
    await owner.cancel(lease);
    assert.equal((await closed)[0], 0, errors);
  },
);
