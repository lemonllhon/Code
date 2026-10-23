import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { PROJECT_NATIVE_METHOD, lcodeProtocolMethods, type LCodeProtocolMessage } from "@lcode/shared";
import { V4_METHODS } from "@lcode/shared/lcode-protocol-v4";
import { LCodeProtocolNdjsonConnection } from "./transport.js";

type Handler = ConstructorParameters<typeof LCodeProtocolNdjsonConnection>[0]["handleMessage"];
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const native = (id: string): LCodeProtocolMessage => ({ id, method: PROJECT_NATIVE_METHOD, params: {} });
const ordinary = (id: string): LCodeProtocolMessage => ({ id, method: V4_METHODS.command, params: {} });

function harness(handleMessage: Handler) {
  const input = new PassThrough();
  const output = new PassThrough();
  const abort = new AbortController();
  const responses: LCodeProtocolMessage[] = [];
  let buffer = "";
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      responses.push(JSON.parse(buffer.slice(0, newline)) as LCodeProtocolMessage);
      buffer = buffer.slice(newline + 1);
    }
  });
  const connection = new LCodeProtocolNdjsonConnection({
    input,
    output,
    signal: abort.signal,
    handleMessage,
  });
  connection.start();
  return {
    input,
    connection,
    responses,
    send: (...messages: LCodeProtocolMessage[]) =>
      input.write(messages.map((message) => JSON.stringify(message)).join("\n") + "\n"),
    close: async () => {
      abort.abort();
      await connection.waitForClose();
      input.destroy();
      output.destroy();
    },
  };
}

test("native admission stat/close bypass both the waiting command and later queued commands", async () => {
  const admission = Promise.withResolvers<void>();
  const order: string[] = [];
  const h = harness(async (message) => {
    if (!("method" in message) || !("id" in message)) return;
    order.push(String(message.id));
    if (message.id === "admission") await admission.promise;
    return { id: message.id, result: {} };
  });
  try {
    h.send(ordinary("admission"));
    await tick();
    h.send(ordinary("following"), native("stat"), native("close"));
    await tick();
    assert.deepEqual(order, ["admission", "stat", "close"]);
    assert.deepEqual(h.responses.map((response) => "id" in response && response.id), ["stat", "close"]);
    admission.resolve();
    await tick();
    assert.deepEqual(order, ["admission", "stat", "close", "following"]);
  } finally {
    admission.resolve();
    await h.close();
  }
});

test("pending native IO does not block ordinary commands, native cancellation/close or error recovery", async () => {
  const running = Promise.withResolvers<void>();
  const order: string[] = [];
  const h = harness(async (message) => {
    if (!("method" in message) || !("id" in message)) return;
    order.push(String(message.id));
    if (message.id === "run") await running.promise;
    if (message.id === "cancelCall") running.resolve();
    return message.id === "invalid"
      ? { id: message.id, error: { code: -32602, message: "Invalid native request" } }
      : { id: message.id, result: {} };
  });
  try {
    h.send(native("run"), ordinary("following"));
    await tick();
    assert.deepEqual(order, ["run", "following"]);
    assert.deepEqual(h.responses.map((response) => "id" in response && response.id), ["following"]);
    h.send(native("cancelCall"), native("close"), native("invalid"), ordinary("after"));
    await tick();
    assert.ok(order.includes("cancelCall"));
    assert.ok(order.includes("close"));
    assert.ok(order.includes("after"));
    assert.equal(h.responses.length, 6);
    assert.equal(h.responses.filter((response) => "error" in response).length, 1);
  } finally {
    running.resolve();
    await h.close();
  }
});

test("native IO does not bypass the configuration barrier for model probes", async () => {
  const configuration = Promise.withResolvers<void>();
  const order: string[] = [];
  const h = harness(async (message) => {
    if (!("method" in message) || !("id" in message)) return;
    order.push(String(message.id));
    if (message.id === "config") await configuration.promise;
    return { id: message.id, result: {} };
  });
  try {
    h.send(
      { id: "config", method: lcodeProtocolMethods.providerUpdateAccountConfig, params: {} },
      { id: "probe", method: lcodeProtocolMethods.providerTestModelConnectivity, params: {} },
      native("stat"),
      ordinary("following"),
    );
    await tick();
    assert.deepEqual(order, ["config", "stat"]);
    configuration.resolve();
    await tick();
    assert.deepEqual(order, ["config", "stat", "probe", "following"]);
  } finally {
    configuration.resolve();
    await h.close();
  }
});

test("EOF includes independent native IO in its drain and returns its response before closing", async () => {
  const running = Promise.withResolvers<void>();
  const h = harness(async (message) => {
    await running.promise;
    return "id" in message ? { id: message.id, result: { kind: "directory" } } : undefined;
  });
  try {
    h.send(native("stat"));
    await tick();
    let closed = false;
    void h.connection.waitForClose().then(() => { closed = true; });
    h.input.end();
    await tick();
    assert.equal(closed, false);
    running.resolve();
    await h.connection.waitForClose();
    assert.deepEqual(h.responses, [{ id: "stat", result: { kind: "directory" } }]);
  } finally {
    running.resolve();
    await h.close();
  }
});

for (const closeKind of ["eof", "abort", "io-error"] as const) {
  test(`${closeKind} bounds native IO lifetime and suppresses late responses`, async () => {
    const running = Promise.withResolvers<void>();
    const h = harness(async (message) => {
      await running.promise;
      return "id" in message ? { id: message.id, result: {} } : undefined;
    });
    try {
      h.send(native("run"));
      await tick();
      if (closeKind === "io-error") {
        const closed = assert.rejects(h.connection.waitForClose(), /fixture IO failure/);
        h.input.emit("error", new Error("fixture IO failure"));
        await closed;
      } else if (closeKind === "eof") {
        h.input.end();
        await h.connection.waitForClose();
      } else await h.close();
      running.resolve();
      await tick();
      assert.deepEqual(h.responses, []);
    } finally {
      running.resolve();
      await h.close().catch(() => undefined);
    }
  });
}
