import assert from "node:assert/strict";
import test from "node:test";
import { Emitter } from "@lcode/rpc";
import type { LCodeProtocolMessage } from "@lcode/shared";
import { LCodeProtocolClient, LCodeProtocolRequestTimeoutError } from "./lcodeProtocolClient.js";
import type { LCodeProtocolTransportClosedEvent } from "./lcodeProtocolTransport.js";

test("optional prediction timeout retains operation residency but cannot recycle the runtime", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const messages = new Emitter<LCodeProtocolMessage>();
  const closed = new Emitter<LCodeProtocolTransportClosedEvent>();
  const client = new LCodeProtocolClient(
    {
      kind: "memory",
      onMessage: messages.event,
      onClose: closed.event,
      send: async () => {},
      dispose: () => {},
    },
    { requestTimeoutMs: 10 },
  );
  t.after(() => {
    client.dispose();
    messages.dispose();
    closed.dispose();
  });
  let healthFailures = 0;
  let drained = 0;
  client.onRequestTimeout(() => {
    healthFailures++;
  });
  client.onPendingRequestsDrained(() => {
    drained++;
  });
  const prediction = client.request("workspace/generateText", {}, undefined, {
    timeoutAffectsRuntimeHealth: false,
  });
  const rejected = assert.rejects(prediction, LCodeProtocolRequestTimeoutError);
  assert.equal(client.pendingOperationRequestCount, 1, "paid generation remains a real operation");
  t.mock.timers.tick(10);
  await rejected;
  assert.equal(healthFailures, 0);
  assert.equal(client.pendingOperationRequestCount, 0);
  assert.equal(drained, 1);
  assert.equal(client.isDisposed, false);
  const ordinary = assert.rejects(
    client.request("workspace/generateText", {}),
    LCodeProtocolRequestTimeoutError,
  );
  t.mock.timers.tick(10);
  await ordinary;
  assert.equal(healthFailures, 1, "ordinary operation timeout still reaches the process owner");
  const observation = assert.rejects(
    client.request("workspace/generateText", {}, undefined, { lifecycle: "observation" }),
    LCodeProtocolRequestTimeoutError,
  );
  assert.equal(client.pendingOperationRequestCount, 0);
  t.mock.timers.tick(10);
  await observation;
  assert.equal(healthFailures, 1);
});
