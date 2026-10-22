import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import test from "node:test";
import { ChannelServer, Event, MessagePortProtocol } from "@lcode/rpc";
import { ISettingService } from "@lcode/services";
import { createMessagePortServiceConnection } from "./messageport.js";

test(
  "peer port closure rejects pending and future RPC without a business timeout",
  { timeout: 2_000 },
  async (t) => {
    const { port1, port2 } = new MessageChannel();
    const connection = createMessagePortServiceConnection(port1 as unknown as MessagePort);
    const protocol = new MessagePortProtocol(port2);
    const server = new ChannelServer(protocol, "fixture");
    const entered = Promise.withResolvers<void>();
    server.registerChannel(ISettingService.channelName, {
      call: async () => {
        entered.resolve();
        return new Promise(() => {});
      },
      listen: () => Event.None,
    });
    t.after(() => {
      connection.dispose();
      server.dispose();
      protocol.disconnect();
    });
    const pending = assert.rejects(
      connection.services.settingService.get(),
      /MessagePort connection closed/,
    );
    await entered.promise;
    port2.close();
    await pending;
    await assert.rejects(connection.services.settingService.get(), /disposed/);
    connection.dispose();
  },
);
