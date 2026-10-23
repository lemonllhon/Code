import assert from "node:assert/strict";
import test from "node:test";
import { PdfRangeRequests } from "./pdfRangeRequests.js";

test("PDF ranges share in-flight IO, retry errors and never retain completed bytes", async () => {
  const reads: {
    begin: number;
    length: number;
    result: ReturnType<typeof Promise.withResolvers<Uint8Array>>;
  }[] = [];
  const delivered: number[] = [];
  const errors: unknown[] = [];
  const owner = new PdfRangeRequests(
    (begin, length) => {
      const result = Promise.withResolvers<Uint8Array>();
      reads.push({ begin, length, result });
      return result.promise;
    },
    (begin) => delivered.push(begin),
    (error) => errors.push(error),
  );
  owner.request(0, 4);
  owner.request(0, 4);
  owner.request(4, 8);
  assert.equal(reads.length, 2);
  reads[0]!.result.resolve(new Uint8Array(4));
  reads[1]!.result.reject(new Error("read failed"));
  await new Promise(setImmediate);
  assert.deepEqual(delivered, [0]);
  assert.equal(errors.length, 1);
  assert.equal(owner.pendingCount, 0);
  owner.request(4, 8);
  assert.equal(reads.length, 3, "a failed range may be retried");
  reads[2]!.result.resolve(new Uint8Array(4));
  await new Promise(setImmediate);
  assert.deepEqual(delivered, [0, 4]);
});

test("aborted PDF suppresses late data and errors without affecting another document", async () => {
  for (const fail of [false, true]) {
    const oldRead = Promise.withResolvers<Uint8Array>();
    const events: string[] = [];
    const old = new PdfRangeRequests(
      () => oldRead.promise,
      () => events.push("old"),
      () => events.push("old-error"),
    );
    old.request(0, 4);
    old.abort();
    old.abort();
    old.request(4, 8);
    assert.equal(old.pendingCount, 0);
    const current = new PdfRangeRequests(
      async () => new Uint8Array(4),
      () => events.push("new"),
      () => events.push("new-error"),
    );
    current.request(0, 4);
    if (fail) oldRead.reject(new Error("late failure"));
    else oldRead.resolve(new Uint8Array(4));
    await new Promise(setImmediate);
    assert.deepEqual(events, ["new"]);
    assert.equal(current.pendingCount, 0);
  }
});
