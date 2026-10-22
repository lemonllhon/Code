import assert from "node:assert/strict";
import test from "node:test";
import { deferred, quotaRoutingFixture } from "./providerAccountQuotaRefresh.fixture.js";

for (const protocol of [
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
] as const)
  test(`expired quota refresh admits consecutive turns without a second model POST per attempt (${protocol})`, async (t) => {
    const f = await quotaRoutingFixture(t, protocol);
    await f.service.getQuota(f.ids[0]!);
    f.advance(60_001);
    assert.equal((await f.send("first")).status, 200);
    assert.equal((await f.send("second")).status, 200);
    assert.equal(f.quotaReads, 2, "one initial read and one refreshed read; fresh TTL is reused");
    assert.equal(f.posts.length, 2);
    assert.equal(
      f.service.readRoutingDiagnostics("commandcode-plan")!.owner.resources[0]!.quality,
      "fresh",
    );
  });

test("cold routing reads quota without opening the account panel and an old ticket cannot replay", async (t) => {
  const f = await quotaRoutingFixture(t);
  assert.equal((await f.send("first")).status, 200);
  assert.equal(f.quotaReads, 1);
  const ticket = f.tickets.get("first")!;
  const repeated = await fetch(ticket.baseURL + f.suffix, {
    method: "POST",
    headers: { authorization: `Bearer ${ticket.apiKey}` },
    body: JSON.stringify({ model: "model" }),
  });
  await repeated.text();
  assert.equal(repeated.status, 403);
  assert.equal(f.posts.length, 1);
});

test("disabled accounts are excluded from automatic quota preparation", async (t) => {
  const f = await quotaRoutingFixture(t, "anthropic-messages", 3);
  await f.service.setAccountEnabled(f.ids[1]!, false);
  await f.service.setAccountEnabled(f.ids[2]!, false);
  assert.equal((await f.send("enabled-only")).status, 200);
  assert.equal(f.quotaReads, 1);
  assert.deepEqual(
    f.posts.map((post) => post.id),
    [f.ids[0]],
  );
});

test("cancelled routing waiter leaves the shared quota read available to another request and the UI", async (t) => {
  const f = await quotaRoutingFixture(t);
  await f.service.getQuota(f.ids[0]!);
  f.advance(60_001);
  const began = deferred<void>(),
    pending = deferred<unknown>();
  let sharedSignal: AbortSignal | undefined;
  f.setQuota(async (context) => {
    sharedSignal = context.signal;
    began.resolve();
    return pending.promise;
  });
  const controller = new AbortController();
  const first = f.send("cancelled", controller.signal);
  void first.catch(() => {});
  await began.promise;
  const second = f.send("other");
  const manual = f.service.getQuota(f.ids[0]!, true);
  controller.abort();
  await assert.rejects(first);
  assert.equal(sharedSignal?.aborted, false);
  assert.equal(f.posts.length, 0);
  pending.resolve({ windows: [{ name: "5 hours", used: 30 }] });
  assert.equal((await second).status, 200);
  assert.equal((await manual).status, "ready");
  assert.equal(f.quotaReads, 2);
  assert.equal(f.posts.length, 1);
});

test("quota preparation reads at most four relevant accounts concurrently", async (t) => {
  const f = await quotaRoutingFixture(t, "anthropic-messages", 7);
  const four = deferred<void>(),
    pending = deferred<unknown>();
  let active = 0,
    maximum = 0;
  f.setQuota(async () => {
    active++;
    maximum = Math.max(maximum, active);
    if (active === 4) four.resolve();
    try {
      return await pending.promise;
    } finally {
      active--;
    }
  });
  const sending = f.send("seven-accounts");
  await four.promise;
  assert.equal(f.quotaReads, 4);
  assert.equal(f.posts.length, 0);
  pending.resolve({ windows: [{ name: "Weekly", used: 20 }] });
  assert.equal((await sending).status, 200);
  assert.equal(f.quotaReads, 7);
  assert.equal(maximum, 4);
  assert.equal(f.posts.length, 1);
});

test("a failed refresh preserves the exclusive probe and cached retry interval, then recovers from a real new reading", async (t) => {
  const f = await quotaRoutingFixture(t);
  await f.service.getQuota(f.ids[0]!);
  f.advance(60_001);
  f.setQuota(async () => {
    throw new Error("fixture private upstream error");
  });
  assert.equal((await f.send("probe")).status, 200);
  const blocked = await f.send("blocked");
  assert.equal(blocked.headers.get("x-zcode-routing-reason"), "reserve-unverifiable");
  assert.equal(f.posts.length, 1);
  assert.equal(f.quotaReads, 2, "failure TTL prevents a refresh loop");
  assert.equal(
    f.service.readRoutingDiagnostics("commandcode-plan")!.owner.resources[0]!.exploration,
    "dispatched",
  );
  f.advance(60_001);
  f.setQuota(async () => ({ windows: [{ name: "5 hours", used: 30 }] }));
  assert.equal((await f.send("recovered")).status, 200);
  assert.equal(f.posts.length, 2);
});

test("fresh unknown Token bounds remain probe-limited instead of force refreshing to bypass protection", async (t) => {
  const f = await quotaRoutingFixture(t);
  f.setQuota(async () => ({
    windows: [{ id: "tokens", name: "Tokens", remaining: 100_000, limit: 100_000, unit: "tokens" }],
  }));
  assert.equal((await f.send("probe")).status, 200);
  const blocked = await f.send("unknown-bound");
  assert.equal(blocked.headers.get("x-zcode-routing-reason"), "reserve-unverifiable");
  assert.equal(f.quotaReads, 1);
  assert.equal(f.posts.length, 1);
});

test("a refreshed exhausted quota stops dispatch", async (t) => {
  const f = await quotaRoutingFixture(t);
  await f.service.getQuota(f.ids[0]!);
  f.advance(60_001);
  f.setQuota(async () => ({ windows: [{ name: "5 hours", used: 100 }] }));
  assert.equal(
    (await f.send("exhausted")).headers.get("x-zcode-routing-reason"),
    "quota-exhausted",
  );
  assert.equal(f.quotaReads, 2);
  assert.equal(f.posts.length, 0);
});

test("a new reading without coverage proof cannot erase the previous local debit", async (t) => {
  const f = await quotaRoutingFixture(t);
  f.setQuota(async () => ({
    windows: [
      {
        id: "budget",
        name: "Budget",
        remaining: 1,
        limit: 1,
        unit: "requests",
        kind: "budget",
        instanceId: "period",
      },
    ],
  }));
  await f.service.getQuota(f.ids[0]!);
  assert.equal((await f.send("spent")).status, 200);
  f.advance(60_001);
  assert.equal(
    (await f.send("not-covered")).headers.get("x-zcode-routing-reason"),
    "quota-exhausted",
  );
  assert.equal(f.quotaReads, 2);
  assert.equal(f.posts.length, 1);
  assert.equal(
    f.service.readRoutingDiagnostics("commandcode-plan")!.owner.resources[0]!.available,
    0,
  );
});

test("quota credential rotation is committed before rebuilding candidates for dispatch", async (t) => {
  const f = await quotaRoutingFixture(t);
  await f.service.getQuota(f.ids[0]!);
  f.advance(60_001);
  f.setQuota(async (context) => {
    await context.write({ ...(await context.read())!, access: "fixture-rotated" });
    return { windows: [{ name: "5 hours", used: 30 }] };
  });
  assert.equal((await f.send("rotating")).status, 200);
  assert.equal(f.posts[0]!.access, "fixture-rotated");
  assert.equal((await f.send("after-rotation")).status, 200);
  assert.equal(f.quotaReads, 2);
});

for (const action of ["disable", "remove", "dispose"] as const)
  test(`${action} during quota preparation prevents a late model dispatch`, async (t) => {
    const f = await quotaRoutingFixture(t);
    const began = deferred<void>(),
      pending = deferred<unknown>();
    f.setQuota(async () => {
      began.resolve();
      return pending.promise;
    });
    const sending = f.send("retired").then(
      (r) => r.status,
      () => 0,
    );
    await began.promise;
    if (action === "disable") await f.service.setAccountEnabled(f.ids[0]!, false);
    else if (action === "remove") await f.service.removeAccount(f.ids[0]!);
    else await f.service.dispose();
    pending.resolve({ windows: [{ name: "Weekly", used: 0 }] });
    assert.notEqual(await sending, 200);
    assert.equal(f.posts.length, 0);
  });
