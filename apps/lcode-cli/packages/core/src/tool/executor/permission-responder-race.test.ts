import assert from "node:assert/strict";
import test from "node:test";
import type { PermissionBrokerResult } from "@lcode/contracts";
import { racePermissionResponders } from "./permission-responder-race.js";

test("committed mode wins once and aborts both original responders", async () => {
  let answer!: (value: PermissionBrokerResult) => void;
  let brokerAborts = 0,
    hookAborts = 0;
  const result = racePermissionResponders({
    requestBroker: (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            brokerAborts++;
            reject(Error("cancelled"));
          },
          { once: true },
        );
      }),
    runHooks: (signal) =>
      new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            hookAborts++;
            resolve({ decision: "deny" });
          },
          { once: true },
        );
      }),
    watchMode: () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  });
  answer({ decision: "allow" });
  assert.deepEqual(await result, { result: { decision: "allow" }, source: "mode" });
  assert.equal(brokerAborts, 1);
  assert.equal(hookAborts, 1);
});

test("a claimed full-access response owns its commit even if a mode watcher finishes late", async () => {
  let committed!: (value: PermissionBrokerResult) => void;
  let modeSignal!: AbortSignal;
  const result = racePermissionResponders({
    requestBroker: (_signal, claim) => {
      assert.equal(claim(), true);
      return new Promise((resolve) => {
        committed = resolve;
      });
    },
    runHooks: async () => ({ decision: "deny" }),
    watchMode: async (signal) => {
      modeSignal = signal;
      return { decision: "deny" };
    },
  });
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(modeSignal.aborted, true);
  committed({ decision: "allow" });
  assert.deepEqual(await result, { source: "broker", result: { decision: "allow" } });
});
