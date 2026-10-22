import test from "node:test";
import assert from "node:assert/strict";
import { handleGitAccountRequest } from "./gitAccountRequest.js";

test("Git account requests enforce session identity, strict payload and active client", async () => {
  const workspace = {
    workspacePath: "/fixture",
    workspaceKey: "identity",
    workspaceIdentity: "identity",
  };
  const request = {
    workspace,
    sessionId: "session",
    operation: { action: "inspect", cwd: "/fixture", url: "https://example.invalid/repo.git" },
  };
  let calls = 0,
    active = true;
  const options = {
    isActive: () => active,
    resolve: async () => {
      calls++;
      return { status: "error", error: "git-account-selection-required" } as const;
    },
  };
  assert.equal((await handleGitAccountRequest(request, workspace, options)).status, "error");
  assert.equal(calls, 1);
  for (const bad of [
    { ...request, token: "secret" },
    { ...request, workspace: { ...workspace, workspaceIdentity: "other" } },
    { ...request, operation: { ...request.operation, action: "bind", username: "alice" } },
  ])
    await handleGitAccountRequest(bad, workspace, options);
  assert.equal(calls, 1);
  active = false;
  await handleGitAccountRequest(request, workspace, options);
  assert.equal(calls, 1);
});
