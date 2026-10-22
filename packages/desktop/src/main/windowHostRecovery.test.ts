import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createWindowHostRecovery } from "./windowHostRecovery.js";

function fixture() {
  let now = 0;
  let allowed = true;
  const expected = new Set<EventEmitter>();
  const restored: number[] = [];
  const exhausted: number[] = [];
  const owner = createWindowHostRecovery({
    now: () => now,
    canRecover: () => allowed,
    isExpectedExit: (child: EventEmitter) => expected.has(child),
    recover: () => restored.push(now),
    onExhausted: () => exhausted.push(now),
    onRecoveryFailed: (error) => {
      throw error;
    },
  });
  return {
    owner,
    expected,
    restored,
    exhausted,
    advance: (ms: number) => {
      now += ms;
    },
    disallow: () => {
      allowed = false;
    },
    exit: async (code = 5) => {
      const child = new EventEmitter();
      owner.watch(child);
      child.emit("exit", code);
      assert.equal(restored.length, 0, "exit cleanup must finish before recovery");
      await Promise.resolve();
      return child;
    },
  };
}

for (const code of [5, 0])
  test(`unexpected Host exit ${code} recovers after synchronous cleanup`, async () => {
    const f = fixture();
    await f.exit(code);
    assert.deepEqual(f.restored, [0]);
    f.owner.dispose();
  });

test("expected disposal, closing, stale child and stale queued recovery never restart", async () => {
  for (const reason of ["dispose", "closing", "replaced", "queued-replaced", "owner-disposed"]) {
    const f = fixture();
    const child = new EventEmitter();
    f.owner.watch(child);
    if (reason === "dispose") f.expected.add(child);
    if (reason === "closing") f.disallow();
    if (reason === "replaced") f.owner.watch(new EventEmitter());
    child.emit("exit", 5);
    if (reason === "queued-replaced") f.owner.watch(new EventEmitter());
    if (reason === "owner-disposed") f.owner.dispose();
    await Promise.resolve();
    assert.equal(f.restored.length, 0, reason);
    f.owner.dispose();
  }
});

test("crash loops stop at three automatic recoveries and explicit retry renews the budget", async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) {
    const child = new EventEmitter();
    f.owner.watch(child);
    child.emit("exit", 5);
    child.emit("exit", 5);
    await Promise.resolve();
  }
  assert.equal(f.restored.length, 3);
  assert.equal(f.exhausted.length, 1);
  f.owner.retry();
  f.owner.retry();
  await Promise.resolve();
  assert.equal(f.restored.length, 4);
  f.owner.dispose();
});

test("the rolling window expires and closing after exit cancels recovery", async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) {
    const child = new EventEmitter();
    f.owner.watch(child);
    child.emit("exit", 5);
    await Promise.resolve();
  }
  f.advance(60_000);
  const next = new EventEmitter();
  f.owner.watch(next);
  next.emit("exit", 5);
  await Promise.resolve();
  assert.equal(f.restored.length, 4);
  f.owner.watch(new EventEmitter());
  f.disallow();
  f.owner.retry();
  await Promise.resolve();
  assert.equal(f.restored.length, 4);
  f.owner.dispose();
});
