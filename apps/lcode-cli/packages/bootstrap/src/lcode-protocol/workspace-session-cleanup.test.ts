import assert from "node:assert/strict";
import test from "node:test";
import { cleanupWorkspaceSessions } from "./workspace-session-cleanup.js";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";

test("workspace cleanup refuses running sessions and reports diagnostics failure before success", async () => {
  const calls: string[] = [];
  let busy = true;
  const context = {
    sessions: new Map([
      [
        "chat",
        {
          app: {
            runtime: { hasResidencyBlockingWork: () => busy },
            close: async () => {
              calls.push("close");
            },
          },
          eventStore: {
            deleteSession: async () => {
              calls.push("events");
            },
          },
        },
      ],
    ]),
    deps: {
      sessionStore: {
        workspaceCleanup: async (params: { sessionIds?: string[] }) => {
          calls.push(params.sessionIds ? "purge" : "query");
          return { sessionIds: ["chat"] };
        },
      },
      deleteSessionDiagnostics: async () => {
        throw new Error("diagnostics failed");
      },
    },
    v4Interactions: { hasPendingForSession: () => false },
    v4Gateway: { hasResidencyBlockingCommands: () => false, disposeSession: () => {} },
  } as unknown as LCodeProtocolAgentServerContext;
  const params = { workspacePath: "/fixture/app", sessionIds: ["chat"] };
  await assert.rejects(cleanupWorkspaceSessions(context, params), /running/);
  assert.deepEqual(calls, ["query"]);
  busy = false;
  await assert.rejects(cleanupWorkspaceSessions(context, params), /diagnostics failed/);
  assert.deepEqual(calls.slice(-4), ["query", "close", "events", "purge"]);
  context.deps.deleteSessionDiagnostics = async () => {
    calls.push("diagnostics");
  };
  assert.deepEqual(await cleanupWorkspaceSessions(context, params), { sessionIds: ["chat"] });
  assert.equal(calls.at(-1), "diagnostics");
});
