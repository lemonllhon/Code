import assert from "node:assert/strict";
import test from "node:test";
import { Emitter } from "@lcode/rpc";
import type { LCodeProtocolMessage } from "@lcode/shared";
import { LCodeProtocolClient } from "./lcodeProtocolClient.js";
import type { LCodeProtocolTransportClosedEvent } from "./lcodeProtocolTransport.js";

test("反向请求保护驻留直到响应真实写入完成，失败写入不伪装完成", async () => {
  const messages = new Emitter<LCodeProtocolMessage>(),
    closed = new Emitter<LCodeProtocolTransportClosedEvent>();
  let finish!: () => void;
  let fail = false;
  const client = new LCodeProtocolClient({
    kind: "memory",
    onMessage: messages.event,
    onClose: closed.event,
    send: async () => {
      if (fail) throw new Error("fixture send failure");
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    dispose: () => {},
  });
  let drained = 0;
  client.onPendingRequestsDrained(() => {
    drained++;
  });
  messages.fire({ id: 42, method: "fixture/reverse" } as LCodeProtocolMessage);
  assert.equal(client.pendingHostRequestCount, 1);
  const responding = client.respond("42", {});
  assert.equal(client.pendingHostRequestCount, 1);
  finish();
  await responding;
  assert.equal(client.pendingHostRequestCount, 0);
  assert.equal(drained, 1);
  messages.fire({ id: 43, method: "fixture/reverse" } as LCodeProtocolMessage);
  fail = true;
  await assert.rejects(client.respondError(43, { code: -1, message: "fixture" }), /send failure/);
  assert.equal(client.pendingHostRequestCount, 1);
  client.dispose();
  assert.equal(client.pendingHostRequestCount, 0);
  messages.dispose();
  closed.dispose();
});
