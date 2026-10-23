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

test("repeated parent/child switching bounds subscriptions, preserves shared panes and isolates Host connections", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  function trackedTransport() {
    let sequence = 0;
    const subscriptions = new Set<string>();
    let listeners = 0;
    const observe = () => {
      listeners++;
      return () => {
        listeners--;
      };
    };
    return {
      subscriptions,
      get listeners() {
        return listeners;
      },
      port: {
        ...transport(),
        subscribe: async () => {
          const subscriptionId = `sub-${++sequence}`;
          subscriptions.add(subscriptionId);
          return { ack: { subscriptionId, mode: "snapshot" as const, logEpoch: "epoch" } };
        },
        unsubscribe: async (id: string) => {
          subscriptions.delete(id);
        },
        sendCommand: async () => assert.fail("closing views cannot send stop/restart commands"),
        onFrame: observe,
        onAssemblyFault: observe,
        onRuntimeRestart: observe,
      } as ConversationTransport,
    };
  }
  const local = trackedTransport(),
    remote = trackedTransport();
  const layer = new SessionDataLayer({
    transport: local.port,
    keepWarmMs: 30_000,
    maxKeepWarmEntries: 8,
  });
  const other = new SessionDataLayer({ transport: remote.port, keepWarmMs: 30_000 });
  t.after(() => {
    layer.dispose();
    other.dispose();
  });
  const parent = layer.acquire("parent"),
    pane = layer.acquire("parent");
  const remoteParent = other.acquire("parent");
  assert.notEqual(parent.store, remoteParent.store);
  const retired = [];
  for (let round = 0; round < 40; round++) {
    const child = layer.acquire(`child-${round}`);
    await new Promise<void>((done) => setImmediate(done));
    child.release();
    retired.push(child);
    assert.ok(layer.size <= 9);
    assert.ok(local.subscriptions.size <= 9);
    assert.equal(remote.subscriptions.size, 1);
  }
  parent.release();
  t.mock.timers.tick(30_000);
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(layer.size, 1);
  assert.equal(local.subscriptions.size, 1);
  assert.notEqual(pane.store.getState().status, "closed");
  assert.notEqual(remoteParent.store.getState().status, "closed");
  assert.ok(
    retired.every(
      ({ store }) => store.getState().status === "closed" && store.getState().snapshot === null,
    ),
  );
  pane.release();
  remoteParent.release();
  t.mock.timers.tick(30_000);
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(local.subscriptions.size, 0);
  assert.equal(remote.subscriptions.size, 0);
  assert.equal(local.listeners, 1, "only the connection-level frame listener remains");
  layer.dispose();
  other.dispose();
  assert.equal(local.listeners, 0);
  assert.equal(remote.listeners, 0);
});
