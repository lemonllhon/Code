import assert from "node:assert/strict";
import test from "node:test";
import { runGitCredentialMetadata } from "./gitCredentialMetadataProcess.js";
test("Metadata runner preserves UTF-8 without a shell and discards failure/over-limit output", async () => {
  const good = await runGitCredentialMetadata({
    executable: process.execPath,
    args: [
      "-e",
      "process.stdin.setEncoding('utf8');process.stdin.on('data',d=>process.stdout.write(d));",
    ],
    input: '{"username":"测试"}',
  });
  assert.equal(good.stdout, '{"username":"测试"}');
  const failed = await runGitCredentialMetadata({
    executable: process.execPath,
    args: [
      "-e",
      "process.stderr.write('private-error');process.stdout.write('private-output');process.exit(1);",
    ],
  });
  assert.deepEqual(failed, { status: "failed", stdout: "" });
  const over = await runGitCredentialMetadata({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(3*1024*1024));"],
  });
  assert.deepEqual(over, { status: "failed", stdout: "" });
  const cancelled = await runGitCredentialMetadata({
    executable: process.execPath,
    args: ["-e", "setInterval(()=>{},1000);"],
    signal: AbortSignal.abort(),
  });
  assert.deepEqual(cancelled, { status: "failed", stdout: "" });
});
