import assert from "node:assert/strict";
import test from "node:test";
import { runHostShutdownPhases } from "./hostShutdownPhases.js";
import { stringifyHostLogArg } from "./hostLog.js";

test("shutdown observes synchronous phase throws and still runs later phases", async () => {
  const ran: string[] = [];
  const result = await runHostShutdownPhases(
    [
      {
        name: "sync",
        run: () => {
          throw new Error("sync failure");
        },
      },
      {
        name: "async",
        run: async () => {
          throw new Error("async failure");
        },
      },
      {
        name: "last",
        run: async () => {
          ran.push("last");
        },
      },
    ],
    { phaseTimeoutMs: 100, log: () => {} },
  );
  assert.deepEqual(ran, ["last"]);
  assert.deepEqual(result.failedPhases, ["sync", "async"]);
  assert.equal(result.exitCode, 1);
});

test("Host logs preserve nested errors, codes, aggregate causes and cyclic context", () => {
  const cause = Object.assign(new Error("connection lost"), { code: "ECONNRESET" });
  const error = new AggregateError([cause], "cleanup failed", { cause });
  const details: Record<string, unknown> = { error };
  details.self = details;
  const logged = JSON.parse(stringifyHostLogArg(details));
  assert.equal(logged.error.message, "cleanup failed");
  assert.equal(logged.error.errors[0].code, "ECONNRESET");
  assert.equal(logged.error.cause.message, "connection lost");
  assert.equal(logged.self, "[Circular]");
  assert.deepEqual(
    JSON.parse(stringifyHostLogArg({ at: new Date(0), bytes: Buffer.from([1, 2]) })),
    { at: new Date(0).toISOString(), bytes: { type: "Buffer", data: [1, 2] } },
  );
});
