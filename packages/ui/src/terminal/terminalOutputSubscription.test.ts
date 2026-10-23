import assert from "node:assert/strict";
import test from "node:test";
import type { ITerminalService, TerminalOutputFrame } from "@lcode/services";
import { subscribeTerminalOutput } from "./terminalOutputSubscription.js";

test("xterm ACK follows actual parse completion, coalesces offsets, and stops with consumer", async () => {
  let output!: (frame: TerminalOutputFrame) => void;
  let listeners = 0;
  const events: unknown[] = [];
  const callbacks: (() => void)[] = [];
  const service = {
    onDynamicOutput: () => (listener: typeof output) => {
      output = listener;
      listeners++;
      return {
        dispose() {
          listeners--;
        },
      };
    },
    beginOutputFlowControl: async () => {
      assert.equal(listeners, 1);
      events.push("begin");
    },
    acknowledgeOutput: async (ack: unknown) => {
      events.push(ack);
    },
  } as unknown as ITerminalService;
  const subscription = subscribeTerminalOutput(
    service,
    "pty",
    {
      write(data, callback) {
        events.push(data);
        if (callback) callbacks.push(callback);
      },
    },
    "cmd",
    true,
  );
  const leaseId = "flow";
  output({ data: "one", flow: { leaseId, offset: 3 } });
  output({ data: "two", flow: { leaseId, offset: 6 } });
  assert.deepEqual(events, ["begin", "one", "two"]);
  callbacks[0]!();
  callbacks[1]!();
  await new Promise(setImmediate);
  assert.deepEqual(events.at(-1), { id: "pty", leaseId, offset: 6 });
  const count = events.length;
  output({ data: "last", flow: { leaseId, offset: 10 } });
  subscription.dispose();
  callbacks[2]!();
  await new Promise(setImmediate);
  assert.equal(events.length, count + 1);
  assert.equal(listeners, 0);
});

test("legacy terminal string output preserves chunk order without flow RPCs", () => {
  let output!: (data: string) => void;
  const chunks: string[] = [];
  const service = {
    onDynamicData: () => (listener: typeof output) => {
      output = listener;
      return { dispose() {} };
    },
  } as unknown as ITerminalService;
  const sub = subscribeTerminalOutput(
    service,
    "old",
    {
      write(data) {
        chunks.push(data as string);
      },
    },
    "cmd",
    false,
  );
  output("\u001b[");
  output("32mgreen");
  output("\r\n");
  assert.equal(chunks.join(""), "\u001b[32mgreen\r\n");
  sub.dispose();
});
