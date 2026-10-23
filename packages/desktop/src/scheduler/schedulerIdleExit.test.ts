import assert from "node:assert/strict";
import test from "node:test";
import { createSchedulerIdleExit } from "./schedulerIdleExit.js";
import { mainToSchedulerMessageSchema, schedulerToMainMessageSchema } from "./schedulerProtocol.js";

test("idle exit waits for tick/settlement and ignores an empty read invalidated by wake", async () => {
  let busy = true;
  let exits = 0;
  let resolve!: (value: boolean) => void;
  const owner = createSchedulerIdleExit({
    hasDemand: () =>
      new Promise((r) => {
        resolve = r;
      }),
    isBusy: () => busy,
    exit: () => {
      exits++;
    },
    onError() {},
  });
  await owner.check();
  assert.equal(exits, 0);
  busy = false;
  const stale = owner.check();
  owner.invalidate();
  resolve(false);
  await stale;
  assert.equal(exits, 0);
  const running = owner.check();
  busy = true;
  resolve(false);
  await running;
  assert.equal(exits, 0);
  busy = false;
  const needed = owner.check();
  resolve(true);
  await needed;
  assert.equal(exits, 0);
  const empty = owner.check();
  resolve(false);
  await empty;
  assert.equal(exits, 1);
  await owner.check();
  assert.equal(exits, 1);
});

test("failed demand reads keep Scheduler available; private control messages reject invalid payloads", async () => {
  let errors = 0;
  const owner = createSchedulerIdleExit({
    hasDemand: async () => {
      throw new Error("db");
    },
    isBusy: () => false,
    exit: () => assert.fail("unknown is not idle"),
    onError: () => {
      errors++;
    },
  });
  await owner.check();
  assert.equal(errors, 1);
  assert.equal(
    mainToSchedulerMessageSchema.safeParse({ type: "scheduler-dispose", unexpected: true }).success,
    false,
  );
  assert.equal(
    mainToSchedulerMessageSchema.safeParse({
      type: "cron-dispatch-result",
      runId: "run",
      ok: "yes",
    }).success,
    false,
  );
  assert.equal(
    schedulerToMainMessageSchema.safeParse({ type: "scheduler-idle-exit" }).success,
    true,
  );
});
