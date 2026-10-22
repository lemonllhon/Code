import assert from "node:assert/strict";
import test from "node:test";
import { signMacExecutable } from "./macos-code-signing.mjs";

test("SEA sealing uses offline ad-hoc signing and verifies before accepting the executable", async () => {
  const calls = [];
  await signMacExecutable("fixture-helper", {
    run: async (...args) => {
      calls.push(args);
    },
  });
  assert.deepEqual(calls, [
    ["/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", "fixture-helper"]],
    ["/usr/bin/codesign", ["--verify", "--strict", "fixture-helper"]],
  ]);
});

test("a failed local seal or verification rejects without assuming Developer ID or Gatekeeper", async () => {
  for (const failureIndex of [0, 1]) {
    let count = 0;
    await assert.rejects(
      signMacExecutable("fixture-helper", {
        run: async () => {
          if (count++ === failureIndex) throw new Error("fixture seal failed");
        },
      }),
      /fixture seal failed/,
    );
    assert.equal(count, failureIndex + 1);
  }
});
