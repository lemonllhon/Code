import { Event, ProxyChannel, type IChannel } from "@lcode/rpc";
import assert from "node:assert/strict";
import test from "node:test";
import { ServiceCollection, ITerminalService, ILCodeTaskService } from "./index.js";
import {
  disposeServiceResourcesAndWait,
  registerBorrowedServiceResources,
  registerServiceResourceDisposer,
} from "./node.js";

test("actual Host resource disposal never probes borrowed proxies and still releases every local registration", async () => {
  const collection = new ServiceCollection();
  const rpcCalls: string[] = [];
  const channel: IChannel = {
    call: async (command) => {
      rpcCalls.push(command);
      throw new Error(`Non-contract RPC: ${command}`);
    },
    listen: () => Event.None,
  };
  const terminal = ProxyChannel.toService<ITerminalService>(channel);
  const task = ProxyChannel.toService<ILCodeTaskService>(channel);
  // 真实 RPC Proxy 对不存在的方法也返回函数，typeof 探测不能证明拥有释放权。
  assert.equal(typeof Reflect.get(terminal, "disposeAllAndWait"), "function");
  collection.register(ITerminalService, terminal).register(ILCodeTaskService, task);
  registerBorrowedServiceResources(collection, [terminal, task]);
  const released: string[] = [];
  registerServiceResourceDisposer(collection, () => {
    released.push("failed");
    throw new Error("fixture subscription failure");
  });
  registerServiceResourceDisposer(collection, () => {
    released.push("last");
  });
  const closing = disposeServiceResourcesAndWait(collection);
  assert.equal(disposeServiceResourcesAndWait(collection), closing);
  await assert.rejects(closing, AggregateError);
  assert.deepEqual(released, ["failed", "last"]);
  assert.deepEqual(rpcCalls, []);
});
