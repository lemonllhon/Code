import assert from "node:assert/strict";
import test from "node:test";
import { RoutingError, RoutingScheduler, type RoutingCandidate } from "../src/routing/index.js";

for (const portability of ["unknown", "provider-session-bound"] as const) {
  test(`bound ${portability} route keeps transient busy cause and retries only the same account`, () => {
    const owner = new RoutingScheduler(
      { version: 1, strategy: "primary-backup" },
      { now: () => 0 },
    );
    const bound: RoutingCandidate = { id: "bound", generation: "1", windows: [], portability };
    const other: RoutingCandidate = { id: "other", generation: "1", windows: [], portability };
    const request = (attemptId: string, turnId = "turn") => ({
      attemptId,
      scopeKey: "same-session",
      turnId,
    });
    const main = owner.reserve([bound, other], request("main"));
    main.dispatch();
    main.finish({ outcome: "success" });
    const title = owner.reserve([bound, other], request("title"));
    title.dispatch();
    const next = request("memory", portability === "provider-session-bound" ? "next-turn" : "turn");
    const plan = owner.plan([other, bound], next);
    assert.deepEqual(plan.routes, []);
    assert.equal(plan.excluded.other, "binding-blocked");
    assert.equal(plan.excluded.bound, "concurrency-full");
    assert.equal(plan.reason, "concurrency-full");
    assert.throws(
      () => owner.reserve([other, bound], next),
      (error: unknown) => {
        assert.ok(error instanceof RoutingError);
        assert.equal(error.code, "concurrency-full");
        assert.equal(error.retryable, true);
        assert.equal(error.details.dispatch, "unsent");
        return true;
      },
    );
    title.finish({ outcome: "success" });
    const memory = owner.reserve([other, bound], { ...next, attemptId: "memory-next" });
    assert.equal(memory.routeId, "bound");
    memory.dispatch();
    memory.finish({ outcome: "success" });
    owner.dispose();
  });
}

test("indexed admission preserves the bound account's transient cause and generation", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "primary-backup" }, { now: () => 0 });
  const candidates: RoutingCandidate[] = [
    { id: "bound", generation: "1", windows: [], portability: "unknown" },
    { id: "other", generation: "1", windows: [], portability: "unknown" },
  ];
  owner.setDirectory(
    candidates.map((c) => c.id),
    (id) => candidates.find((c) => c.id === id)!,
  );
  const request = (attemptId: string) => ({ attemptId, scopeKey: "session", turnId: "turn" });
  const main = owner.reserveIndexed(request("main"));
  main.dispatch();
  main.finish({ outcome: "success" });
  const title = owner.reserveIndexed(request("title"));
  title.dispatch();
  assert.throws(
    () => owner.reserveIndexed(request("memory")),
    (error: unknown) =>
      error instanceof RoutingError && error.code === "concurrency-full" && error.retryable,
  );
  title.finish({ outcome: "success" });
  const memory = owner.reserveIndexed(request("retry"));
  assert.equal(memory.routeId, "bound");
  memory.cancel();
  owner.dispose();
});

test("a present bound account reports cooling even if another account appears first", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "primary-backup" }, { now: () => 0 });
  const bound: RoutingCandidate = {
    id: "bound",
    generation: "1",
    windows: [],
    portability: "unknown",
  };
  const other: RoutingCandidate = {
    id: "other",
    generation: "1",
    windows: [],
    portability: "unknown",
  };
  const initial = owner.reserve([bound, other], {
    scopeKey: "session",
    turnId: "turn",
    attemptId: "main",
  });
  initial.dispatch();
  initial.finish({ outcome: "success" });
  assert.throws(
    () =>
      owner.reserve([other, { ...bound, unavailable: "route-cooling", availableAt: 1000 }], {
        scopeKey: "session",
        turnId: "turn",
        attemptId: "memory",
      }),
    (error: unknown) => {
      assert.ok(error instanceof RoutingError);
      assert.equal(error.code, "route-cooling");
      assert.equal(error.retryable, true);
      assert.equal(error.details.retryAt, 1000);
      return true;
    },
  );
  owner.dispose();
});

for (const changed of ["missing", "generation"] as const) {
  test(`bound account ${changed} remains a permanent binding denial without fallback`, () => {
    const owner = new RoutingScheduler(
      { version: 1, strategy: "primary-backup" },
      { now: () => 0 },
    );
    const bound: RoutingCandidate = {
      id: "bound",
      generation: "1",
      windows: [],
      portability: "unknown",
    };
    const other: RoutingCandidate = {
      id: "other",
      generation: "1",
      windows: [],
      portability: "unknown",
    };
    const initial = owner.reserve([bound, other], {
      scopeKey: "session",
      turnId: "turn",
      attemptId: "main",
    });
    initial.dispatch();
    initial.finish({ outcome: "success" });
    const candidates = changed === "missing" ? [other] : [other, { ...bound, generation: "2" }];
    assert.equal(
      owner.plan(candidates, { scopeKey: "session", turnId: "turn", attemptId: "next" }).reason,
      "binding-blocked",
    );
    assert.throws(
      () => owner.reserve(candidates, { scopeKey: "session", turnId: "turn", attemptId: "next" }),
      (error: unknown) => {
        assert.ok(error instanceof RoutingError);
        assert.equal(error.code, "binding-blocked");
        assert.equal(error.retryable, false);
        return true;
      },
    );
    owner.dispose();
  });
}
