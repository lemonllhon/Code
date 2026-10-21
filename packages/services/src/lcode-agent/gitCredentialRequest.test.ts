import test from "node:test";
import assert from "node:assert/strict";
import { handleGitCredentialRequest } from "./gitCredentialRequest.js";

const workspace = {
  workspacePath: "/fixture/repo",
  workspaceKey: "identity-A",
  workspaceIdentity: "identity-A",
};
const request = {
  workspace,
  sessionId: "fixture-session",
  cwd: "/fixture/repo",
  url: "https://example.invalid/repo.git",
  transport: "http",
};
test("Private Git credential requests use attached identity and refuse stale clients", async () => {
  let active = true,
    calls = 0;
  const resolve = async () => {
    calls++;
    return { kind: "http" as const, username: "fixture", password: "fixture-secret" };
  };
  assert.equal(
    (await handleGitCredentialRequest(request, workspace, { isActive: () => active, resolve }))
      .kind,
    "http",
  );
  assert.equal(calls, 1);
  const other = {
    ...request,
    workspace: { ...workspace, workspaceIdentity: "identity-B", workspaceKey: "identity-B" },
  };
  assert.equal(
    (await handleGitCredentialRequest(other, workspace, { isActive: () => active, resolve })).kind,
    "error",
  );
  assert.equal(calls, 1);
  active = false;
  assert.equal(
    (await handleGitCredentialRequest(request, workspace, { isActive: () => active, resolve }))
      .kind,
    "error",
  );
  assert.equal(calls, 1);
  active = true;
  const late = await handleGitCredentialRequest(request, workspace, {
    isActive: () => active,
    resolve: async () => {
      active = false;
      return resolve();
    },
  });
  assert.equal(late.kind, "error");
  assert.ok(!JSON.stringify(late).includes("fixture-secret"));
});
test("Malformed private requests and unavailable capabilities do not invoke auth", async () => {
  let called = false;
  const options = {
    isActive: () => true,
    resolve: async () => {
      called = true;
      return { kind: "error" as const, error: "git-account-selection-required" };
    },
  };
  for (const input of [
    { ...request, cwd: 3 },
    { ...request, url: "https://example.invalid/\nsecret" },
    { ...request, token: "not-admitted" },
  ])
    assert.equal((await handleGitCredentialRequest(input, workspace, options)).kind, "error");
  assert.equal(called, false);
  assert.equal(
    (await handleGitCredentialRequest(request, workspace, { isActive: () => true })).kind,
    "error",
  );
});
