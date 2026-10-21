import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import {
  createRootTraceContext,
  createSessionId,
  type CreateSessionInput,
  type Model,
  type SessionEntryInfo,
  type SessionStorePort,
} from "@lcode/contracts";
import { buildRemoteWorkspaceIdentity } from "@lcode/shared";
import { AgentRuntime } from "../agent-runtime.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { AgentRuntimeConfig } from "../types.js";

for (const kind of ["local", "remote", "memory-identity", "worktree"] as const) {
  test(`Agent child persists the ${kind} workspace independently of a changed cwd`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "lcode-child-workspace-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cwd = join(root, "nested");
    await mkdir(cwd);
    const workspacePath = root + sep;
    const clientMode = kind === "local" ? "desktop-continuous" : "web-remote-replayable";
    const identity =
      kind === "local"
        ? undefined
        : buildRemoteWorkspaceIdentity(workspacePath, { kind: "docker", container: "fixture" });
    const binding =
      kind === "worktree"
        ? {
            workspacePath,
            workspaceIdentity: identity,
            workspaceKey: identity!,
            executionBindingId: "fixture-binding",
            originWorkspacePath: join(root, "origin"),
            originWorkspaceIdentity: "fixture-origin",
          }
        : undefined;
    const created: CreateSessionInput[] = [];
    const entries: SessionEntryInfo[] = [];
    const store = {
      createSession: async (input: CreateSessionInput) => {
        created.push(input);
        return { ...input, time: { created: 1, updated: 1 } };
      },
      saveSessionEntry: async (entry: SessionEntryInfo) => {
        entries.push(entry);
        return entry;
      },
      updateSession: async () => ({}),
    } as unknown as SessionStorePort;
    const parentId = createSessionId("workspace-parent");
    const model = {
      providerId: "fixture",
      modelId: "fixture",
      options: {},
      properties: { contextWindow: 200_000 },
    } as Model;
    let sequence = 0;
    const resolveGitContext = async () => ({
      status: "available" as const,
      partial: false,
      repositories: [],
    });
    const parent = new AgentRuntime(
      parentId,
      {
        workingDirectory: root,
        workspacePath,
        workspaceIdentity:
          kind === "remote" ? (identity as AgentRuntimeConfig["workspaceIdentity"]) : undefined,
        // Protocol 仍有从 memory 配置注入身份的调用方，必须覆盖这一真实入口。
        memory: {
          enabled: false,
          workspaceIdentity: kind === "remote" ? "stale-memory" : identity,
        },
        workspaceBinding: binding,
        remoteSessionId: identity ? "fixture-attachment" : undefined,
        clientMode,
        deliveryKind: clientMode,
        mode: "yolo",
        modelSelection: { providerId: "fixture", modelId: "fixture" },
        subagents: { outputRootDir: root },
        mcp: { enabled: false },
      },
      {
        sessionStore: store,
        eventStore: {
          append: async (event: object) => ({ ...event, sequenceNumber: ++sequence }),
          load: async () => [],
        } as never,
        modelFactory: () => model,
        resolveGitContext,
      },
    );
    let childConfig: AgentRuntimeConfig | undefined;
    const original = AgentRuntime.prototype.executeTurn;
    AgentRuntime.prototype.executeTurn = async function () {
      const child = this as unknown as AgentRuntimeInternal;
      assert.equal(
        child.resolveGitContext,
        resolveGitContext,
        "Child metadata stays bound to the parent's authorized provider",
      );
      childConfig = child.config;
      await child.ensureSessionPersisted("workspace regression", child.rootTraceContext);
      return { response: "verified", events: [], traceId: child.rootTraceContext.traceId } as never;
    };
    try {
      const result = await (parent as unknown as AgentRuntimeInternal).subagentPort!.run({
        sessionId: parentId,
        agentType: "general-purpose",
        description: "workspace regression",
        prompt: "verify workspace",
        parentToolCallId: "fixture-tool",
        workingDirectory: cwd,
        workspaceRoot: root,
        trace: createRootTraceContext({ sessionId: parentId }),
      });
      assert.equal(result.status, "completed");
      assert.equal(created.length, 1);
      assert.equal(created[0].path, workspacePath);
      assert.equal(created[0].workspaceID, identity);
      assert.equal(created[0].parentID, parentId);
      assert.equal(childConfig?.workingDirectory, cwd);
      assert.equal(childConfig?.remoteSessionId, identity ? "fixture-attachment" : undefined);
      assert.equal(childConfig?.clientMode, clientMode);
      assert.equal(childConfig?.deliveryKind, clientMode);
      assert.deepEqual(created[0].initialEntries?.[0]?.data, binding);
      assert.ok(entries.length > 0, "the real persistence path ran before the Agent completed");
    } finally {
      AgentRuntime.prototype.executeTurn = original;
    }
  });
}
