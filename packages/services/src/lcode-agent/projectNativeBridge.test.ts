import test from "node:test";
import assert from "node:assert/strict";
import { ProjectNativeBridge } from "./projectNativeBridge.js";
import type { ProjectNativeRequest } from "@lcode/shared";
import { ChannelClient, ChannelServer, ProxyChannel, createQueuePair } from "@lcode/rpc";
import type { ILCodeAgentService } from "./lcodeAgent.js";

function connect(bridge: ProjectNativeBridge) {
  type Contract = Pick<
    ILCodeAgentService,
    "onDynamicProjectNativeRequest" | "respondProjectNative"
  > & {
    barrier(): Promise<void>;
  };
  const service: Contract = {
    onDynamicProjectNativeRequest: () => (listener) => bridge.subscribe(listener),
    respondProjectNative: async ({ requestId, result }) => bridge.respond(requestId, result),
    barrier: async () => {},
  };
  const [a, b] = createQueuePair();
  const server = new ChannelServer(b, "project-native-fixture");
  server.registerChannel("agent", ProxyChannel.fromService(service));
  const client = new ChannelClient(a);
  return {
    service: ProxyChannel.toService<Contract>(client.getChannel("agent")),
    dispose() {
      client.dispose();
      server.dispose();
    },
  };
}

const request = (ownerId: string): ProjectNativeRequest => ({
  ownerId,
  callId: ownerId,
  routeToken: "frozen-capability",
  operation: { port: "filesystem", method: "stat", args: [{ path: "/app" }] },
});
test("native bridge replays pending transport requests, cancels only the retired resource owner, and closes permanently", async () => {
  const bridge = new ProjectNativeBridge();
  const first = bridge.call(request("first"), "origin");
  const subscription = bridge.subscribe((event) =>
    bridge.respond(event.requestId, { value: { kind: "directory" } }),
  );
  assert.deepEqual(await first, { kind: "directory" });
  subscription.dispose();
  const retired = bridge.call(request("retired-generation"), "origin");
  const active = bridge.call(request("active-generation"), "origin");
  bridge.cancelOwners(new Set(["retired-generation"]));
  await assert.rejects(retired, /owner closed/);
  const listener = bridge.subscribe((event) =>
    bridge.respond(event.requestId, { value: event.request.ownerId }),
  );
  assert.equal(await active, "active-generation");
  listener.dispose();
  const closing = bridge.call(request("pending"), "origin");
  bridge.dispose();
  await assert.rejects(closing, /connection closed/);
  await assert.rejects(bridge.call(request("late"), "origin"), /connection closed/);
});

test(
  "dynamic native requests replay across serialized subscriptions and retire the old connection listener",
  { timeout: 10_000 },
  async (t) => {
    const bridge = new ProjectNativeBridge();
    t.after(() => bridge.dispose());
    const old = connect(bridge);
    t.after(() => old.dispose());
    const seen: string[] = [];
    const pending = bridge.call(request("before-subscription"), "origin");
    const oldSubscription = old.service.onDynamicProjectNativeRequest()((event) => {
      seen.push(event.request.ownerId);
      void old.service.respondProjectNative({
        requestId: event.requestId,
        result: { value: event.originKey },
      });
    });
    assert.equal(await pending, "origin");
    oldSubscription.dispose();
    await old.service.barrier();
    const duringDisconnect = bridge.call(request("during-disconnect"), "origin");
    old.dispose();
    const next = connect(bridge);
    t.after(() => next.dispose());
    const subscription = next.service.onDynamicProjectNativeRequest()((event) => {
      seen.push(event.request.ownerId);
      void next.service.respondProjectNative({
        requestId: event.requestId,
        result: { value: event.request.callId },
      });
    });
    assert.equal(await duringDisconnect, "during-disconnect");
    assert.equal(await bridge.call(request("live"), "origin"), "live");
    assert.deepEqual(seen, ["before-subscription", "during-disconnect", "live"]);
    subscription.dispose();
    await next.service.barrier();
    const retired = bridge.call(request("retired"), "origin");
    bridge.cancelOwners(new Set(["retired"]));
    await assert.rejects(retired, /owner closed/);
    assert.deepEqual(seen, ["before-subscription", "during-disconnect", "live"]);
  },
);
