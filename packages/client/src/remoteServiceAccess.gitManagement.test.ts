import assert from "node:assert/strict";
import test from "node:test";
import { Event, type IChannel, type IChannelClient } from "@lcode/rpc";
import { IGitManagementService } from "@lcode/services";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";
test("Git management proxy forwards to its Host and preserves missing-channel failures", async () => {
  const calls: { channel: string; method: string; args: unknown }[] = [];
  const unavailable = new Error("Channel not found: git-management");
  let missing = false;
  const client: IChannelClient = {
    getChannel<T extends IChannel>(channel: string): T {
      return {
        call: async (method: string, args: unknown) => {
          calls.push({ channel, method, args });
          if (missing) throw unavailable;
          return { revision: "fixture" };
        },
        listen: () => Event.None,
      } as unknown as T;
    },
  };
  const service = new RemoteServiceAccess(client).gitManagementService;
  await service.getSnapshot();
  await service.detect();
  await service.authorize({ type: "poll", requestId: crypto.randomUUID() });
  assert.deepEqual(
    calls.map((c) => [c.channel, c.method]),
    [
      [IGitManagementService.channelName, "getSnapshot"],
      [IGitManagementService.channelName, "detect"],
      [IGitManagementService.channelName, "authorize"],
    ],
  );
  missing = true;
  await assert.rejects(service.getSnapshot(), (error) => error === unavailable);
});
