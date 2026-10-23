import assert from "node:assert/strict";
import test from "node:test";
import { SessionDataLayer } from "./sessionDataLayer.js";
import type { ConversationTransport } from "./transport.js";

function transport(): ConversationTransport {
  let next = 0;
  return {
    subscribe: async () => ({
      ack: { subscriptionId: `sub-${++next}`, mode: "snapshot", logEpoch: "epoch" },
    }),
    activate() {},
    unsubscribe: async () => {},
    onFrame: () => () => {},
    onAssemblyFault: () => () => {},
    onRuntimeRestart: () => () => {},
  } as unknown as ConversationTransport;
}

test("warm projection budget evicts only unreferenced views; reacquire uses original subscription path", async () => {
  const layer = new SessionDataLayer({
    transport: transport(),
    keepWarmMs: 60_000,
    maxKeepWarmEntries: 2,
  });
  const active = layer.acquire("active");
  const anotherPane = layer.acquire("active");
  const old = layer.acquire("old");
  old.release();
  const hot = layer.acquire("hot");
  hot.release();
  const latest = layer.acquire("latest");
  latest.release();
  assert.equal(old.store.getState().status, "closed");
  assert.equal(old.store.getState().snapshot, null);
  assert.notEqual(active.store.getState().status, "closed");
  assert.equal(layer.size, 3);
  const reopen = layer.acquire("old");
  assert.equal(reopen.openKind, "cold");
  assert.notEqual(reopen.store, old.store);
  active.release();
  assert.notEqual(anotherPane.store.getState().status, "closed");
  anotherPane.release();
  reopen.release();
  layer.dispose();
  await new Promise(setImmediate);
});

test("pending optimistic command protects its original view from count eviction", async () => {
  const layer = new SessionDataLayer({
    transport: transport(),
    keepWarmMs: 60_000,
    maxKeepWarmEntries: 0,
  });
  const pending = layer.acquire("pending");
  pending.store.markCommandPending({ commandId: "send", type: "sendText", issuedAt: 1 });
  pending.release();
  const ordinary = layer.acquire("ordinary");
  ordinary.release();
  assert.notEqual(pending.store.getState().status, "closed");
  assert.equal(ordinary.store.getState().status, "closed");
  const same = layer.acquire("pending");
  assert.equal(same.store, pending.store);
  same.release();
  layer.dispose();
  await new Promise(setImmediate);
});
