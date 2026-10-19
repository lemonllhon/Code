import assert from "node:assert/strict";
import test from "node:test";
import { ChannelClient, ChannelServer } from "../src/channels.js";
import { CancellationToken, CancellationTokenSource } from "../src/foundation.js";
import { createQueuePair } from "../src/protocol.js";
import { ProxyChannel } from "../src/proxy-channel.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function connect<T extends object>(service: T, deferInit = false) {
  const [a, b] = createQueuePair();
  const server = new ChannelServer(b, "fixture", 1000, deferInit);
  server.registerChannel("fixture", ProxyChannel.fromService(service));
  const client = new ChannelClient(a);
  return {
    service: ProxyChannel.toService<T>(client.getChannel("fixture")),
    server,
    dispose() {
      client.dispose();
      server.dispose();
    },
  };
}

test("cancellable proxy crosses real serialization without serializing its signal", async (t) => {
  const received: unknown[] = [];
  const h = connect({
    async generate(params: { prompt: string }, token?: CancellationToken) {
      received.push(params);
      assert.equal(typeof token?.onCancellationRequested, "function");
      assert.equal(token?.isCancellationRequested, false);
      return params.prompt;
    },
    async ordinary(...args: unknown[]) {
      return args;
    },
  });
  t.after(() => h.dispose());
  const controller = new AbortController();
  assert.equal(
    await h.service.generate(
      { prompt: "synthetic" },
      CancellationToken.fromAbortSignal(controller.signal),
    ),
    "synthetic",
  );
  assert.deepEqual(received, [{ prompt: "synthetic" }]);
  assert.deepEqual(await h.service.ordinary("one", { __rpcCancellation: true, args: [] }), [
    "one",
    { __rpcCancellation: true, args: [] },
  ]);
});

test("in-flight proxy cancellation reaches the Host's native AbortSignal", async (t) => {
  const started = deferred();
  const settled = deferred();
  const h = connect({
    async generate(_params: object, token?: CancellationToken) {
      const bridge = CancellationToken.toAbortSignal(token!);
      try {
        started.resolve();
        await new Promise<void>((_resolve, reject) => {
          bridge.signal.addEventListener(
            "abort",
            () => reject(new Error("physical request aborted")),
            { once: true },
          );
        });
      } finally {
        bridge.dispose();
        settled.resolve();
      }
    },
  });
  t.after(() => h.dispose());
  const controller = new AbortController();
  const result = h.service.generate({}, CancellationToken.fromAbortSignal(controller.signal));
  const rejected = assert.rejects(result, /Cancelled/);
  await started.promise;
  controller.abort();
  await rejected;
  await settled.promise;
});

test("cancellation before token creation and before channel initialization performs no work", async (t) => {
  let calls = 0;
  const h = connect(
    {
      async generate(_params: object, _token?: CancellationToken) {
        calls++;
      },
    },
    true,
  );
  t.after(() => h.dispose());
  const source = new CancellationTokenSource();
  t.after(() => source.dispose());
  source.cancel();
  assert.equal(source.token.isCancellationRequested, true);
  await assert.rejects(h.service.generate({}, source.token), /Cancelled/);
  const pending = new CancellationTokenSource();
  t.after(() => pending.dispose());
  const result = h.service.generate({}, pending.token);
  const rejected = assert.rejects(result, /Cancelled/);
  pending.cancel();
  pending.cancel();
  h.server.ready();
  await rejected;
  assert.equal(calls, 0);
});

test("forwarded proxies preserve cancellation through each serialized hop", async (t) => {
  const started = deferred();
  const cancelled = deferred();
  const inner = connect({
    async generate(_params: object, token?: CancellationToken) {
      started.resolve();
      return new Promise<void>((resolve) =>
        token!.onCancellationRequested(() => {
          cancelled.resolve();
          resolve();
        }),
      );
    },
  });
  const outer = connect(inner.service);
  t.after(() => {
    outer.dispose();
    inner.dispose();
  });
  const controller = new AbortController();
  const result = outer.service.generate({}, CancellationToken.fromAbortSignal(controller.signal));
  const rejected = assert.rejects(result, /Cancelled/);
  await started.promise;
  controller.abort();
  await rejected;
  await cancelled.promise;
});

test("native signal bridges expose early abort and release completed listeners", () => {
  const controller = new AbortController();
  const token = CancellationToken.fromAbortSignal(controller.signal);
  let notifications = 0;
  const subscription = token.onCancellationRequested(() => notifications++);
  const bridge = CancellationToken.toAbortSignal(token);
  subscription.dispose();
  bridge.dispose();
  controller.abort();
  assert.equal(notifications, 0);
  assert.equal(bridge.signal.aborted, false);
  assert.equal(token.isCancellationRequested, true);
  const early = CancellationToken.toAbortSignal(token);
  assert.equal(early.signal.aborted, true);
  early.dispose();
});
