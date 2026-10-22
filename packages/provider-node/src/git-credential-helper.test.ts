import test from "node:test";
import assert from "node:assert/strict";
import { createGitCredentialHelper } from "./git-credential-helper.js";
import { LCODE_GIT_CREDENTIAL_HELPER_COMMAND } from "@lcode/shared";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { GitCredentialResolver } from "./git-credential-helper.js";

test("Only issued system credentials can report success; erase revokes their receipt without forwarding secrets", async () => {
  const calls: Parameters<GitCredentialResolver>[0][] = [],
    id = randomUUID();
  const helper = createGitCredentialHelper(async (input) => {
    calls.push(input);
    return input.operation === "approve"
      ? { kind: "ack" }
      : { kind: "http", username: "fixture", password: "fixture-private", attemptId: id };
  });
  try {
    const env = await helper.environment();
    const request = async (operation?: string) => {
      const response = await fetch(env.LCODE_GIT_HELPER_ENDPOINT!, {
        method: "POST",
        headers: { authorization: "Bearer " + env.LCODE_GIT_HELPER_CAPABILITY },
        body: JSON.stringify({
          cwd: "/fixture",
          url: "https://fixture@example.invalid/repo.git",
          transport: "http",
          operation,
        }),
      });
      return response.json();
    };
    await request("approve");
    assert.equal(calls.length, 0);
    await request();
    await request("approve");
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.attemptId, id);
    assert.ok(!JSON.stringify(calls).includes("fixture-private"));
    await request("approve");
    assert.equal(calls.length, 2);
    await request();
    await request("reject");
    await request("approve");
    assert.equal(calls.length, 3, "Rejected credentials must not later be approved");
  } finally {
    await helper.close();
  }
});

test("Private helper preserves existing config and clears inherited credential traces", async () => {
  const helper = createGitCredentialHelper(async () => ({
    kind: "error",
    error: "git-account-selection-required",
  }));
  try {
    const env = await helper.environment({
      GIT_CONFIG_COUNT: "2",
      GIT_CURL_VERBOSE: "1",
      GCM_TRACE: "sensitive-trace",
      GIT_TRACE_REDACT: "0",
      GIT_SSH_COMMAND: "ssh -F custom.conf",
      LCODE_GIT_BINARY: "C:/Git with spaces/bin/git.exe",
    });
    assert.equal(env.GIT_CONFIG_COUNT, "8");
    assert.equal(env.GCM_ALLOW_WINDOWSAUTH, "false");
    assert.equal(env.GIT_CONFIG_KEY_2, "credential.helper");
    assert.equal(env.GIT_CONFIG_VALUE_2, "");
    assert.equal(env.GIT_CURL_VERBOSE, undefined);
    assert.equal(env.GCM_TRACE, undefined);
    assert.equal(env.GIT_TRACE_REDACT, "1");
    assert.equal(env.LCODE_GIT_ORIGINAL_SSH_COMMAND, "ssh -F custom.conf");
    assert.equal(env.LCODE_GIT_BINARY, "C:/Git with spaces/bin/git.exe");
    await assert.rejects(helper.environment({ GIT_CONFIG_COUNT: "-1" }));
    await assert.rejects(helper.environment({ GIT_CONFIG_COUNT: "NaN" }));
  } finally {
    await helper.close();
  }
  await assert.rejects(helper.environment());
});

test("SEA selects an internal command instead of trying to execute an external script", async () => {
  const helper = createGitCredentialHelper(
    async () => ({ kind: "error", error: "git-account-selection-required" }),
    { isSea: true },
  );
  try {
    const env = await helper.environment();
    assert.ok(env.GIT_CONFIG_VALUE_1!.includes(LCODE_GIT_CREDENTIAL_HELPER_COMMAND));
    assert.ok(!env.GIT_CONFIG_VALUE_1!.includes("helper.cjs"));
    assert.ok(env.GIT_SSH_COMMAND!.includes(LCODE_GIT_CREDENTIAL_HELPER_COMMAND));
  } finally {
    await helper.close();
  }
});

test("Internal CLI helper consumes the fixed protocol before migrations, config and session initialization", async () => {
  const root = await mkdtemp(join(tmpdir(), "lcode-internal-git-helper-"));
  const helper = createGitCredentialHelper(async () => ({
    kind: "http",
    username: "fixture",
    password: "fixture-private",
  }));
  try {
    const env = await helper.environment();
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (done, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            import.meta.resolve("tsx"),
            fileURLToPath(
              new URL("../../../apps/lcode-cli/packages/cli/src/main.ts", import.meta.url),
            ),
            LCODE_GIT_CREDENTIAL_HELPER_COMMAND,
            "http",
            "get",
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              ...env,
              HOME: root,
              USERPROFILE: root,
              LCODE_DATA_BASE_DIR: root,
            },
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        let stdout = "",
          stderr = "";
        const timeout = setTimeout(() => {
          child.kill();
          reject(new Error("Internal Git helper did not finish"));
        }, 15000);
        child.stdout.on("data", (value) => {
          stdout += value;
        });
        child.stderr.on("data", (value) => {
          stderr += value;
        });
        child.on("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.on("exit", (code) => {
          clearTimeout(timeout);
          done({ code, stdout, stderr });
        });
        child.stdin.end("protocol=https\nhost=example.invalid\npath=fixture.git\n\n");
      },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "username=fixture\npassword=fixture-private\n\n");
    await assert.rejects(stat(join(root, ".lcode")), { code: "ENOENT" });
  } finally {
    await helper.close();
  }
});
