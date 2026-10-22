import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { gitCredentialRequestSchema, gitCredentialResultSchema } from "./gitAuthentication.js";

test("Private credential lifecycle keeps old get requests and validates success receipts strictly", () => {
  const get = {
    workspace: { workspacePath: "/fixture", workspaceKey: "/fixture" },
    sessionId: "fixture",
    cwd: "/fixture",
    url: "https://git.example.invalid/repo.git",
    transport: "http",
  };
  assert.ok(gitCredentialRequestSchema.safeParse(get).success);
  const approve = { ...get, operation: "approve", attemptId: randomUUID() };
  assert.ok(gitCredentialRequestSchema.safeParse(approve).success);
  for (const value of [
    { ...approve, attemptId: undefined },
    { ...approve, transport: "ssh" },
    { ...approve, operation: "get" },
    { ...approve, password: "must-not-cross" },
  ])
    assert.equal(gitCredentialRequestSchema.safeParse(value).success, false);
  assert.ok(gitCredentialResultSchema.safeParse({ kind: "ack" }).success);
  assert.equal(
    gitCredentialResultSchema.safeParse({ kind: "ack", password: "must-not-cross" }).success,
    false,
  );
});
