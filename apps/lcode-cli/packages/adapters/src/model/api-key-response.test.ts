import assert from "node:assert/strict";
import test from "node:test";
import { observeApiKeyResponse } from "./api-key-response.js";

test("SR-08 source read rejection remains physical completion when abort concurrently rejects cancel", async () => {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const abort = new AbortController();
  const ended: boolean[] = [];
  const response = observeApiKeyResponse(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          source = controller;
        },
      }),
    ),
    abort.signal,
    (success) => {
      ended.push(success);
    },
  );
  const reader = response.body!.getReader();
  const pending = reader.read();
  source.error(new TypeError("fixture transport already ended"));
  abort.abort();
  await assert.rejects(pending, /fixture transport already ended/);
  await assert.rejects(reader.cancel());
  assert.deepEqual(
    ended,
    [false],
    "the original source terminal error closes the lease exactly once",
  );
});
