import test from "node:test";
import assert from "node:assert/strict";
import {
  withGitAuthenticationScope,
  currentGitAuthenticationScope,
} from "./gitAuthenticationScope.js";

test("Concurrent Git callers retain their identity across awaits without contaminating other operations", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const seen: string[] = [];
  const service = withGitAuthenticationScope({
    async fetch(request: { workspacePath: string; workspaceIdentity?: string }) {
      await gate;
      seen.push(currentGitAuthenticationScope()!.workspaceIdentity!);
      return request.workspacePath;
    },
    read() {
      return currentGitAuthenticationScope();
    },
  });
  const a = service.fetch({ workspacePath: "/same/path", workspaceIdentity: "identity-A" }),
    b = service.fetch({ workspacePath: "/same/path", workspaceIdentity: "identity-B" });
  assert.equal(service.read(), undefined);
  release();
  await Promise.all([a, b]);
  assert.deepEqual(seen.sort(), ["identity-A", "identity-B"]);
  assert.equal(currentGitAuthenticationScope(), undefined);
});
