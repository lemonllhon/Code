import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRemoteWorkspaceIdentity,
  type ProjectContextSnapshot,
  type ProjectNativeRequest,
  type ProjectNativeResult,
} from "@lcode/shared";
import { createWindowProjectNativeRouter } from "./windowProjectNativeRouter.js";

test("window signs frozen endpoints, checks origin and generation, and never falls back to local", async () => {
  const calls: Array<{
    endpoint: { remoteSessionId?: string; generation?: number };
    request: ProjectNativeRequest;
  }> = [];
  let generation = 1;
  const member = {
    memberId: "A",
    label: "A",
    role: "",
    description: "",
    sourcePath: "/app",
    workspacePath: "/app",
    workspaceIdentity: buildRemoteWorkspaceIdentity("/app", {
      kind: "wsl" as const,
      distro: "Fixture",
    }),
  };
  const input: ProjectContextSnapshot = {
    version: 1,
    projectId: "p",
    name: "Mixed",
    description: "",
    revision: 1,
    origin: { workspacePath: "C:\\project" },
    execution: { workspacePath: member.workspacePath, workspaceIdentity: member.workspaceIdentity },
    members: [member],
  };
  const router = createWindowProjectNativeRouter({
    resolveTarget: async (source) => ({
      workspacePath: source.workspacePath,
      workspaceIdentity: source.workspaceIdentity,
      remoteSessionId: "device-A",
      generation,
    }),
    execute: async (endpoint, request): Promise<ProjectNativeResult> => {
      calls.push({ endpoint, request });
      if (endpoint.generation !== generation) throw new Error("stale-generation");
      return request.operation.method === "stat" ? { kind: "directory" } : { exitCode: 23 };
    },
  });
  const snapshot = await router.prepare(input);
  assert.equal(input.members[0]!.routeToken, undefined);
  assert.ok(snapshot.members[0]!.routeToken);
  assert.equal(calls[1]!.request.operation.method, "close");
  const request: ProjectNativeRequest = {
    ownerId: "chat",
    callId: "operation",
    routeToken: snapshot.execution.routeToken!,
    operation: {
      port: "execution",
      method: "run",
      args: [{ command: { mode: "argv", file: "fixture" } }],
    },
  };
  assert.deepEqual(await router.call(request, "C:\\project"), { exitCode: 23 });
  await assert.rejects(router.call(request, "C:\\another"), /another source/);
  await assert.rejects(
    router.call({ ...request, routeToken: request.routeToken + "x" }, "C:\\project"),
    /Invalid/,
  );
  generation++;
  await assert.rejects(router.call(request, "C:\\project"), /stale-generation/);
  assert.equal(calls.at(-1)!.endpoint.remoteSessionId, "device-A");
});
