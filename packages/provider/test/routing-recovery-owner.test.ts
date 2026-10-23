import assert from "node:assert/strict";
import test from "node:test";
import { RoutingRecovery, type RoutingRecoveryPermit } from "../src/routing/recovery.js";

test("RCD-05 cooling expiry admits one probe and physical end alone cannot confirm recovery", () => {
  const owner = new RoutingRecovery();
  const failed = owner.reserve(["model"], "failed", 0);
  owner.dispatch(failed, 0);
  owner.fail(failed, ["model"], 100);
  assert.throws(() => owner.reserve(["model"], "early", 99), /route-cooling/);
  const probe = owner.reserve(["model"], "probe", 100);
  for (let i = 0; i < 20; i++)
    assert.throws(() => owner.reserve(["model"], `other-${i}`, 100), /route-cooling/);
  owner.dispatch(probe, 100);
  owner.finish(probe, "unknown", 100);
  assert.equal(owner.inspect(100)[0]!.phase, "uncertain");
  assert.throws(() => owner.reserve(["model"], "after-body", 1000), /route-cooling/);
  owner.observe(probe, "success", 1000);
  assert.ok(owner.reserve(["model"], "healthy", 1000));
});

test("RCD-05 unsent cancellation rolls back the probe, stale callbacks cannot change a later probe", () => {
  const owner = new RoutingRecovery();
  const failed = owner.reserve(["a"], "first", 0);
  owner.fail(failed, ["a"], 1);
  const probe = owner.reserve(["a"], "probe", 1);
  owner.cancel(probe);
  const replacement = owner.reserve(["a"], "replacement", 1);
  owner.cancel(probe);
  owner.finish(probe, "success", 2);
  owner.observe(probe, "success", 2);
  assert.throws(() => owner.reserve(["a"], "still-blocked", 2), /route-cooling/);
  owner.dispatch(replacement, 2);
  owner.observe(replacement, "success", 2);
  owner.finish(replacement, "unknown", 2);
  assert.ok(owner.reserve(["a"], "recovered", 2));
});

test("RCD-05 multiple resources admit atomically and distinct scopes remain independent", () => {
  const owner = new RoutingRecovery();
  const failed = owner.reserve(["a", "b"], "failure", 0);
  owner.fail(failed, ["a", "b"], 1);
  const b = owner.reserve(["b"], "b", 1);
  assert.throws(() => owner.reserve(["a", "b"], "both", 1), /route-cooling/);
  const a = owner.reserve(["a"], "a", 1);
  assert.ok(owner.reserve(["unrelated"], "unrelated", 1));
  owner.cancel(a);
  owner.cancel(b);
});

test("RCD-06 serializing and reopening recovery state retains an uncertain dispatched probe", () => {
  const state = {};
  const first = new RoutingRecovery(state);
  const failed = first.reserve(["pool"], "failed", 0);
  first.fail(failed, ["pool"], 1);
  const probe = first.reserve(["pool"], "probe", 1);
  first.dispatch(probe, 1);
  const second = new RoutingRecovery(JSON.parse(JSON.stringify(state)));
  assert.throws(() => second.reserve(["pool"], "new-process", 100000), /route-cooling/);
  assert.equal(JSON.stringify(second.inspect(100000)).includes('"probe":"probe"'), false);
});

for (const feedbackFirst of [true, false])
  test(`SR-01 cancelled probe recovers only after physical end (feedback first: ${feedbackFirst})`, () => {
    const owner = new RoutingRecovery();
    const first = owner.reserve(["model"], "first", 0);
    owner.fail(first, ["model"], 1);
    const probe = owner.reserve(["model"], "probe", 1);
    owner.dispatch(probe, 1);
    if (feedbackFirst) owner.observe(probe, "cancelled", 2);
    assert.throws(() => owner.reserve(["model"], "before-end", 100), /route-cooling/);
    owner.finish(probe, feedbackFirst ? "unknown" : "cancelled", 100);
    if (!feedbackFirst) owner.observe(probe, "cancelled", 100);
    assert.equal(owner.inspect(100)[0]!.phase, "cooling");
    assert.equal(owner.retryAt(["model"]), 1100);
    owner.finish(probe, "cancelled", 500);
    assert.equal(owner.retryAt(["model"]), 1100, "duplicate end must not extend cooldown");
    assert.ok(owner.reserve(["other-model"], "other-session", 100));
    const replacement = owner.reserve(["model"], "replacement", 1100);
    owner.observe(probe, "success", 1101);
    owner.finish(probe, "failed", 1101);
    assert.throws(() => owner.reserve(["model"], "competitor", 1101), /route-cooling/);
    owner.dispatch(replacement, 1101);
    owner.observe(replacement, "success", 1101);
    owner.finish(replacement, "unknown", 1101);
    assert.equal(owner.available(["model"], 1101), true);
  });

test("SR-03 legacy ended cancellation can recover without resetting other unknown probes", () => {
  const state = {
    model: {
      revision: 3,
      retryAt: 1,
      phase: "uncertain" as const,
      probe: "old",
      dispatched: true,
      physicalEnded: true,
      outcome: "cancelled" as const,
    },
    other: {
      revision: 2,
      retryAt: 1,
      phase: "uncertain" as const,
      probe: "unknown",
      dispatched: true,
      physicalEnded: true,
    },
  };
  const old: RoutingRecoveryPermit = {
    token: "old",
    versions: { model: 3 },
    probes: ["model"],
    dispatched: true,
    physicalEnded: true,
    outcome: "cancelled" as const,
  };
  const owner = new RoutingRecovery(state, [old]);
  const deadlineState = new RoutingRecovery({
    ...state,
    blocked: { revision: 1, retryAt: 2000, phase: "cooling" },
  });
  assert.equal(
    deadlineState.retryAt(["model", "blocked"]),
    2000,
    "an eligible legacy cancellation cannot hide another resource's deadline",
  );
  const before = JSON.stringify(state);
  assert.equal(owner.available(["model"], 1000), true);
  owner.inspect(1000);
  assert.equal(JSON.stringify(state), before, "diagnostic reads cannot mutate persisted state");
  const next = owner.reserve(["model"], "new", 1000);
  assert.equal(old.closed, true);
  assert.throws(() => owner.reserve(["other"], "unsafe", 86400000), /route-cooling/);
  owner.finish(old, "success", 1001);
  assert.throws(() => owner.reserve(["model"], "competing", 1001), /route-cooling/);
  owner.cancel(next);
});

test("SR-06 routing rejection identifies cooling, probing and uncertain without inventing a deadline", () => {
  const owner = new RoutingRecovery();
  const first = owner.reserve(["model"], "first", 0);
  owner.fail(first, ["model"], 100);
  const reject = (time: number, recoveryState: string, retryAt?: number) =>
    assert.throws(
      () => owner.reserve(["model"], "rejected", time),
      (error: unknown) => {
        const details = (error as { details: Record<string, unknown> }).details;
        assert.equal(details.recoveryState, recoveryState);
        assert.equal(details.retryAt, retryAt);
        assert.equal(details.dispatch, "unsent");
        return true;
      },
    );
  reject(1, "cooling", 100);
  const probe = owner.reserve(["model"], "probe", 100);
  owner.dispatch(probe, 100);
  reject(100, "probing");
  owner.finish(probe, "unknown", 100);
  reject(100, "uncertain");
});
