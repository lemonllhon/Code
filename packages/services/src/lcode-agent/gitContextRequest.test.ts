import test from "node:test";
import assert from "node:assert/strict";
import { handleGitContextRequest } from "./gitContextRequest.js";
import type { GitAgentContext, LCodeWorkspaceRef } from "@lcode/shared";

const workspace: LCodeWorkspaceRef = {
  workspacePath: "/fixture/repo",
  workspaceIdentity: "identity-A",
  workspaceKey: "identity-A",
};
const request = { workspace, sessionId: "fixture-session" };
const available: GitAgentContext = { status: "available", partial: false, repositories: [] };
test("Private Git context uses the attached identity and drops late, malformed and secret-bearing responses", async () => {
  let active = true,
    calls = 0;
  const resolve = async () => {
    calls++;
    return available;
  };
  const options = { isActive: () => active, resolve };
  assert.deepEqual(await handleGitContextRequest(request, workspace, options), available);
  for (const bad of [
    {
      ...request,
      workspace: { ...workspace, workspaceIdentity: "identity-B", workspaceKey: "identity-B" },
    },
    { ...request, cwd: "/untrusted" },
    { ...request, token: "fixture-secret" },
    { ...request, sessionId: 5 },
  ])
    assert.deepEqual(await handleGitContextRequest(bad, workspace, options), {
      status: "unavailable",
    });
  assert.equal(calls, 1);
  active = false;
  await handleGitContextRequest(request, workspace, options);
  assert.equal(calls, 1);
  active = true;
  assert.deepEqual(
    await handleGitContextRequest(request, workspace, {
      ...options,
      resolve: async () => {
        active = false;
        return available;
      },
    }),
    { status: "unavailable" },
  );
  active = true;
  assert.deepEqual(
    await handleGitContextRequest(request, workspace, {
      ...options,
      resolve: async () => ({ ...available, token: "fixture-secret" }),
    }),
    { status: "unavailable" },
  );
});
test("Worktree and execution-set requests cannot bypass the original scope owner", async () => {
  let calls = 0;
  const options = {
    isActive: () => true,
    resolve: async () => {
      calls++;
      return available;
    },
  };
  for (const ref of [
    { ...workspace, executionBindingId: "missing" },
    { ...workspace, executionSetRef: { origin: workspace, executionSetId: "a".repeat(32) } },
  ])
    assert.deepEqual(
      await handleGitContextRequest({ ...request, workspace: ref }, workspace, options),
      { status: "unavailable" },
    );
  assert.equal(calls, 0);
  assert.deepEqual(await handleGitContextRequest(request, workspace, { isActive: () => true }), {
    status: "unavailable",
  });
});

test("Ready worktrees and current execution sets read context, while preparing or changed owners refuse it", async () => {
  let calls = 0,
    ready = true;
  const resolve = async () => {
    calls++;
    return available;
  };
  const worktree = {
    ...workspace,
    workspacePath: "/fixture/checkout",
    executionBindingId: "binding",
    originWorkspacePath: workspace.workspacePath,
    originWorkspaceIdentity: workspace.workspaceIdentity,
  };
  const worktrees = {
    getBinding: async () => ({
      id: "binding",
      workspacePath: worktree.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      originalWorkspacePath: workspace.workspacePath,
      originalWorkspaceIdentity: workspace.workspaceIdentity,
      status: ready ? "ready" : "preparing",
    }),
  } as never;
  assert.equal(
    (
      await handleGitContextRequest({ ...request, workspace: worktree }, workspace, {
        isActive: () => true,
        resolve,
        worktrees,
      })
    ).status,
    "available",
  );
  ready = false;
  assert.equal(
    (
      await handleGitContextRequest({ ...request, workspace: worktree }, workspace, {
        isActive: () => true,
        resolve,
        worktrees,
      })
    ).status,
    "unavailable",
  );
  assert.equal(calls, 1);
  const origin = {
    workspacePath: workspace.workspacePath,
    workspaceIdentity: workspace.workspaceIdentity,
  };
  const reference = {
    executionSetId: "a".repeat(32),
    projectId: "fixture",
    origin,
    bindings: [
      {
        repositoryId: "b".repeat(32),
        bindingId: "c".repeat(32),
        workspacePath: "/fixture/execution",
      },
    ],
  };
  const execution = {
    workspacePath: "/fixture/execution",
    workspaceIdentity: "execution-key",
    workspaceKey: "execution-key",
    executionSetRef: reference,
  };
  let changed = false;
  const executionSets = {
    resolveContext: async () => ({
      reference: changed ? { ...reference, executionSetId: "d".repeat(32) } : reference,
      context: { execution },
    }),
  } as never;
  assert.equal(
    (
      await handleGitContextRequest({ ...request, workspace: execution }, workspace, {
        isActive: () => true,
        resolve,
        executionSets,
      })
    ).status,
    "available",
  );
  changed = true;
  assert.equal(
    (
      await handleGitContextRequest({ ...request, workspace: execution }, workspace, {
        isActive: () => true,
        resolve,
        executionSets,
      })
    ).status,
    "unavailable",
  );
  assert.equal(calls, 2);
});
