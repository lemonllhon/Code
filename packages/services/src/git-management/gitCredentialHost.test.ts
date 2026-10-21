import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHostGitCredentialResolver } from "./gitCredentialHost.js";
import type { GitManagementOwner } from "./gitManagementService.js";

test("Host credential scope checks real directories and isolates missing sibling folders", async () => {
  const parent = await mkdtemp(join(tmpdir(), "lcode-git-auth-scope-")),
    root = join(parent, "repo"),
    other = join(parent, "other");
  await mkdir(root);
  await mkdir(other);
  let calls = 0;
  const owner = {
    repositoryCredential: async () => {
      calls++;
      return { kind: "http", username: "fixture", password: "fixture-secret" };
    },
  } as unknown as GitManagementOwner;
  const resolver = createHostGitCredentialResolver(owner, async () => [
    root,
    join(parent, "missing"),
  ]);
  const scope = { workspacePath: root, workspaceKey: root },
    request = {
      workspace: scope,
      sessionId: "fixture",
      cwd: root,
      url: "https://example.invalid/repo.git",
      transport: "http" as const,
    };
  assert.equal((await resolver(scope, request)).kind, "http");
  assert.equal(calls, 1);
  for (const changed of [
    { ...request, cwd: other },
    { ...request, transport: "ssh" as const },
    { ...request, url: "https://user:secret@example.invalid/repo.git" },
  ]) {
    const result = await resolver(scope, changed);
    assert.equal(result.kind, "error");
    assert.ok(!JSON.stringify(result).includes("fixture-secret"));
  }
  assert.equal(calls, 1);
});
