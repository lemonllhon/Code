import test from "node:test";
import assert from "node:assert/strict";
import { createGitToolEntry } from "./git.js";
import { assertGitNetworkResultVisible } from "./bash-git-result-policy.js";
import type { ToolExecutionContext } from "../types.js";

test("Network Git masking is refused before execution while ordinary Git and shell behavior stay compatible", () => {
  for (const command of [
    "git fetch origin | tail -2",
    "cd /repo && git push origin main 2>&1 | tail -3; git fetch origin; git rev-parse HEAD",
    "git fetch origin; echo ok",
    "git fetch origin || true",
    "timeout 60 git fetch origin | tail -2",
  ]) {
    assert.throws(() => assertGitNetworkResultVisible(command), /Git tool/);
  }
  for (const command of [
    "git status --short | wc -l",
    "git fetch origin",
    "cd /repo && git push origin main && git ls-remote origin",
    "echo hello | tail -1",
    "git show fetch | tail -1",
  ])
    assert.doesNotThrow(() => assertGitNetworkResultVisible(command));
});

test("Git tool forwards one argv operation and preserves the actual exit and full authentication error with no retry", async () => {
  let calls = 0;
  const failure =
    "git-account-selection-required\nSelect or reload the repository account in Git > Remotes\nfatal: could not read Username";
  const context = {
    workingDirectory: process.cwd(),
    workspaceRoot: process.cwd(),
    abortSignal: new AbortController().signal,
    executionPort: {
      run: async (request: any) => {
        calls++;
        assert.deepEqual(request.command, {
          mode: "argv",
          file: "git",
          args: ["fetch", "--", "origin", "main"],
        });
        return {
          status: "failed",
          exitCode: 128,
          stdout: { text: "", bytes: 0, truncated: false },
          stderr: { text: failure, bytes: failure.length, truncated: false },
          timedOut: false,
          cancelled: false,
          durationMs: 1,
          startedAt: new Date(),
          completedAt: new Date(),
        };
      },
    },
  } as unknown as ToolExecutionContext;
  const result = (await createGitToolEntry().handler(
    { action: "fetch", refs: ["main"] },
    context,
  )) as any;
  assert.equal(result.exitCode, 128);
  assert.equal(result.stderr, failure);
  assert.match(String(createGitToolEntry().formatModelContent!(result)), /Exit code 128/);
  assert.equal(calls, 1);
  const formatted = createGitToolEntry().formatModelContent!({
    ...result,
    stderrTruncated: true,
    stderrPersistedOutputPath: "/fixture/full-stderr.log",
  });
  assert.match(String(formatted), /Full stderr: \/fixture\/full-stderr.log/);
});
