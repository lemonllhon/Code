import assert from "node:assert/strict";
import test from "node:test";
import {
  createInMemorySessionEventStore,
  type SessionId,
  type SessionInfo,
} from "@lcode/contracts";
import { buildRemoteWorkspaceIdentity } from "@lcode/shared";
import { childHistoryFixture } from "./child-history-readonly.fixture.js";
import { resolveConversationReader } from "./conversation-reader.js";
import type { LCodeProtocolSessionRecord } from "./server-types.js";
import { createConversationV4Gateway } from "./v4-bridge.js";
import { WORKTREE_BINDING_ENTRY } from "./worktree-execution.js";

function legacyFixture(active: boolean, nested = false) {
  const f = childHistoryFixture();
  const parent = {
    ...f.stored,
    id: "parent" as SessionId,
    taskType: "interactive",
    parentID: undefined,
    workspaceID: undefined,
    path: "fixture-root/",
    directory: "fixture-root/nested",
  } as unknown as SessionInfo;
  const child = {
    ...f.stored,
    taskType: "subagent_child",
    parentID: nested ? "middle" : parent.id,
    workspaceID: undefined,
    path: "fixture-root/nested",
    directory: "fixture-root/nested",
  } as unknown as SessionInfo;
  const middle = { ...child, id: "middle" as SessionId, parentID: parent.id };
  const sessions = new Map([parent, child, ...(nested ? [middle] : [])].map((s) => [s.id, s]));
  f.store.getSession = async (id) => sessions.get(id) ?? null;
  const workspace = { workspacePath: parent.path!, workspaceKey: parent.path! };
  if (active)
    f.context.sessions.set(parent.id, {
      workspace,
      eventStore: createInMemorySessionEventStore(),
      app: {},
    } as unknown as LCodeProtocolSessionRecord);
  return { ...f, child, parent, sessions, workspace };
}

for (const clientMode of ["desktop-continuous", "web-remote-replayable"] as const)
  for (const active of [false, true])
    for (const nested of [false, true])
      test(`${clientMode} reads legacy child with parent active=${active}, nested=${nested}`, async () => {
        const f = legacyFixture(active, nested);
        const gateway = createConversationV4Gateway(f.context);
        try {
          const subscribed = await gateway.subscribe({
            topic: `conversation/${f.sessionId}`,
            connectionId: "fixture",
            clientMode,
            workspace: f.workspace,
          });
          assert.ok(subscribed.ack.subscriptionId);
          const result = await gateway.rowsRange({
            sessionId: f.sessionId,
            limit: 20,
            clientMode,
            workspace: f.workspace,
          });
          assert.ok(JSON.stringify(result).includes("saved child reply"));
          assert.equal(f.context.sessions.size, active ? 1 : 0);
          assert.equal(f.appCreations(), 0);
          assert.equal(f.child.path, "fixture-root/nested", "reading never rewrites old history");
        } finally {
          gateway.dispose();
        }
      });

test("legacy remote child inherits the durable parent binding and checks identity and attachment", async () => {
  const f = legacyFixture(false);
  const identity = buildRemoteWorkspaceIdentity("/fixture", { kind: "docker", container: "a" });
  const execution = {
    workspacePath: "/fixture",
    workspaceIdentity: identity,
    workspaceKey: identity,
    originWorkspacePath: "/origin",
    originWorkspaceIdentity: "fixture-origin",
    remoteSessionId: "attachment-a",
  };
  f.parent.workspaceID = identity as SessionInfo["workspaceID"];
  f.store.sessionEntries = async ({ sessionID }) =>
    sessionID === f.parent.id ? ([{ type: WORKTREE_BINDING_ENTRY, data: execution }] as never) : [];
  const reader = await resolveConversationReader(f.context, f.sessionId, execution);
  assert.equal(reader.workspace.workspaceIdentity, identity);
  assert.equal(reader.workspace.workspacePath, "/fixture");
  assert.equal(reader.workspace.remoteSessionId, "attachment-a");
  await assert.rejects(
    resolveConversationReader(f.context, f.sessionId, {
      ...execution,
      workspaceIdentity: buildRemoteWorkspaceIdentity("/fixture", {
        kind: "docker",
        container: "b",
      }),
    }),
    /workspaceMismatch/,
  );
  await assert.rejects(
    resolveConversationReader(f.context, f.sessionId, {
      ...execution,
      remoteSessionId: "attachment-b",
    }),
    /remoteSessionMismatch/,
  );
  const origin = await resolveConversationReader(f.context, f.sessionId, {
    workspacePath: "/origin",
    workspaceKey: "fixture-origin",
    workspaceIdentity: "fixture-origin",
  });
  assert.equal(origin.workspace.workspaceIdentity, identity);
});

test("an explicit child identity cannot borrow another workspace's active parent", async () => {
  const f = legacyFixture(true);
  f.child.workspaceID = "other-workspace" as SessionInfo["workspaceID"];
  await assert.rejects(resolveConversationReader(f.context, f.sessionId), /workspaceMismatch/);
});

test("a malformed explicit binding never falls back to the legacy parent workspace", async () => {
  const f = legacyFixture(true);
  f.store.sessionEntries = async ({ sessionID }) =>
    sessionID === f.child.id
      ? ([{ type: WORKTREE_BINDING_ENTRY, data: { workspacePath: 123 } }] as never)
      : [];
  await assert.rejects(resolveConversationReader(f.context, f.sessionId), { name: "ZodError" });
});

test("a legacy child with a missing parent retains its local path fallback", async () => {
  const f = legacyFixture(false);
  f.sessions.delete(f.parent.id);
  const reader = await resolveConversationReader(f.context, f.sessionId, {
    workspacePath: f.child.path!,
    workspaceKey: f.child.path!,
  });
  assert.equal(reader.workspace.workspacePath, f.child.path);
  await assert.rejects(
    resolveConversationReader(f.context, f.sessionId, f.workspace),
    /workspaceMismatch/,
  );
});

test("an intermediate explicit workspace mismatch cannot be hidden by a matching root", async () => {
  const f = legacyFixture(true, true);
  f.child.workspaceID = f.workspace.workspaceKey as SessionInfo["workspaceID"];
  f.sessions.get("middle" as SessionId)!.workspaceID =
    "other-workspace" as SessionInfo["workspaceID"];
  await assert.rejects(resolveConversationReader(f.context, f.sessionId), /workspaceMismatch/);
});

test("a cold fork reads its own workspace without borrowing a different parent workspace", async () => {
  const f = legacyFixture(false);
  f.child.taskType = "fork";
  f.child.workspaceID = "fork-workspace" as SessionInfo["workspaceID"];
  const reader = await resolveConversationReader(f.context, f.sessionId, {
    workspacePath: f.child.path!,
    workspaceKey: "fork-workspace",
    workspaceIdentity: "fork-workspace",
  });
  assert.equal(reader.workspace.workspaceIdentity, "fork-workspace");
  assert.equal(reader.record, undefined);
  assert.equal(f.appCreations(), 0);
});

test("cold fork history remains readable when a foreign parent becomes active", async () => {
  const f = legacyFixture(true);
  f.child.taskType = "fork";
  f.child.workspaceID = "fork-workspace" as SessionInfo["workspaceID"];
  const workspace = {
    workspacePath: f.child.path!,
    workspaceIdentity: "fork-workspace",
    workspaceKey: "fork-workspace",
  };
  const reader = await resolveConversationReader(f.context, f.sessionId, workspace);
  assert.equal(reader.record, undefined);
  assert.equal(reader.workspace.workspaceIdentity, "fork-workspace");
  assert.equal(f.appCreations(), 0);
  assert.equal(f.context.sessions.size, 1);
});

for (const clientMode of ["desktop-continuous", "web-remote-replayable"] as const) {
  for (const active of [false, true])
    test(`${clientMode} legacy worktree child accepts verified origin with parent active=${active}`, async () => {
      const f = legacyFixture(active, true);
      const execution = {
        workspacePath: "fixture-worktree",
        workspaceKey: "fixture-execution",
        workspaceIdentity: "fixture-execution",
        originWorkspacePath: "fixture-origin",
        originWorkspaceIdentity: "fixture-origin",
      };
      f.store.sessionEntries = async ({ sessionID }) =>
        sessionID === f.parent.id
          ? ([{ type: WORKTREE_BINDING_ENTRY, data: execution }] as never)
          : [];
      if (active) f.context.sessions.get(f.parent.id)!.workspace = execution;
      const requested = {
        workspacePath: "fixture-origin",
        workspaceKey: "fixture-origin",
        workspaceIdentity: "fixture-origin",
      };
      const gateway = createConversationV4Gateway(f.context);
      try {
        const reader = await resolveConversationReader(f.context, f.sessionId, requested);
        assert.equal(reader.workspace.workspaceIdentity, execution.workspaceIdentity);
        await gateway.subscribe({
          topic: `conversation/${f.sessionId}`,
          connectionId: "fixture",
          clientMode,
          workspace: requested,
        });
        assert.equal(f.appCreations(), 0);
        assert.equal(f.context.sessions.size, active ? 1 : 0);
      } finally {
        gateway.dispose();
      }
    });
}

test("legacy child parent cycles and store failures remain explicit", async () => {
  const f = legacyFixture(false);
  f.parent.taskType = "subagent_child";
  f.parent.parentID = f.child.id;
  await assert.rejects(resolveConversationReader(f.context, f.sessionId), /parentCycle/);
  f.store.getSession = async (id) => {
    if (id === f.child.id) return f.child;
    throw new Error("fixture parent read failed");
  };
  await assert.rejects(
    resolveConversationReader(f.context, f.sessionId),
    /fixture parent read failed/,
  );
});
