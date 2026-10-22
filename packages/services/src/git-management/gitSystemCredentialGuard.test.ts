import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createSystemGitCredentialGuard,
  resetSystemGitCredentialAttempts,
  type SystemGitCredentialAttempt,
} from "./gitSystemCredentialGuard.js";
import type { GitCommandProvider } from "../git/providers/gitCommandProvider.js";

function fixture() {
  let attempts: SystemGitCredentialAttempt[] = [];
  let changes = Promise.resolve();
  let calls = 0;
  let failSave = false;
  const command: GitCommandProvider = {
    resolveGitBinary: async () => "git",
    run: async (input) => {
      calls++;
      assert.equal(input.env?.GCM_ALLOW_WINDOWSAUTH, "false");
      assert.equal(input.env?.GCM_INTERACTIVE, "Never");
      assert.ok(input.args.includes("credential.allowWindowsAuth=false"));
      return {
        binaryPath: "git",
        cwd: input.cwd,
        args: input.args,
        stdout: `username=${input.stdin?.match(/username=([^\n]+)/)?.[1] ?? "alice"}\npassword=fixture-private\n\n`,
        stderr: "",
        exitCode: 0,
        signal: null,
        durationMs: 0,
        timedOut: false,
        outputTruncated: false,
      };
    },
  };
  const create = () =>
    createSystemGitCredentialGuard({
      change: <T>(
        edit: (state: { systemCredentialAttempts: SystemGitCredentialAttempt[] }) => T,
      ) => {
        const next = changes.then(() => {
          const state = { systemCredentialAttempts: structuredClone(attempts) };
          const result = edit(state);
          if (failSave) throw new Error("fixture-save-failed");
          attempts = state.systemCredentialAttempts;
          return result;
        });
        changes = next.then(
          () => {},
          () => {},
        );
        return next;
      },
    });
  return {
    create,
    command,
    calls: () => calls,
    state: () => ({ systemCredentialAttempts: attempts }),
    failSave: () => {
      failSave = true;
    },
  };
}
const url = "https://git.example.invalid/team/repo.git";

test("System admission persists before fill and survives concurrency, other repos and owner recreation", async () => {
  const f = fixture();
  const results = await Promise.allSettled([
    f.create().read(f.command, "/first", url, "alice"),
    f.create().read(f.command, "/other", url.replace("repo.git", "other.git"), "Alice"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.calls(), 1);
  await assert.rejects(
    f.create().read(f.command, "/first", url, "alice"),
    /system-credential-blocked/,
  );
  assert.equal(f.calls(), 1);
  assert.ok(!JSON.stringify(f.state()).includes("fixture-private"));
});

test("Only a matching success releases admission; stale completion cannot release a new attempt", async () => {
  const f = fixture(),
    guard = f.create();
  const first = await guard.read(f.command, "/repo", url, "alice");
  assert.equal(first.kind, "http");
  if (first.kind !== "http") return;
  assert.ok(first.attemptId);
  await guard.approve(url, "bob", first.attemptId!);
  await guard.approve(url, "alice", randomUUID());
  await assert.rejects(guard.read(f.command, "/repo", url, "alice"), /system-credential-blocked/);
  await guard.approve(url, "alice", first.attemptId!);
  const second = await guard.read(f.command, "/repo", url, "alice");
  if (second.kind !== "http") throw new Error("expected HTTP");
  await guard.approve(url, "alice", first.attemptId!);
  await assert.rejects(guard.read(f.command, "/repo", url, "alice"), /system-credential-blocked/);
  await guard.approve(url, "alice", second.attemptId!);
  await guard.read(f.command, "/repo", url, "alice");
});

test("Unknown identity is mutually exclusive; reset is explicit and scoped to server and user", async () => {
  const f = fixture(),
    guard = f.create();
  await guard.read(f.command, "/repo", url);
  await assert.rejects(guard.read(f.command, "/repo", url, "bob"), /system-credential-blocked/);
  resetSystemGitCredentialAttempts(f.state(), url, "alice");
  await guard.read(f.command, "/repo", url, "alice");
  await guard.read(f.command, "/repo", url, "bob");
  await guard.read(f.command, "/repo", "https://other.example.invalid/repo.git", "alice");
  await assert.rejects(guard.read(f.command, "/repo", url), /system-credential-blocked/);
  resetSystemGitCredentialAttempts(f.state(), url, "bob");
  await assert.rejects(guard.read(f.command, "/repo", url, "alice"), /system-credential-blocked/);
});

test("Persistence failure never reaches the credential helper; fill failure retains admission", async () => {
  const f = fixture();
  f.failSave();
  await assert.rejects(f.create().read(f.command, "/repo", url), /save-failed/);
  assert.equal(f.calls(), 0);
  const g = fixture(),
    guard = g.create();
  const failed = {
    ...g.command,
    run: async () => {
      throw new Error("fixture-fill-failed");
    },
  };
  await assert.rejects(guard.read(failed, "/repo", url), /fill-failed/);
  await assert.rejects(guard.read(g.command, "/repo", url), /system-credential-blocked/);
  assert.equal(g.calls(), 0);
});

test("A URL username is enforced even without a saved account", async () => {
  const f = fixture(),
    guard = f.create();
  const result = await guard.read(f.command, "/repo", url.replace("https://", "https://bob@"));
  assert.equal(result.kind === "http" && result.username, "bob");
  await assert.rejects(guard.read(f.command, "/other", url, "BOB"), /system-credential-blocked/);
});
