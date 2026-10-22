import assert from "node:assert/strict";
import test from "node:test";
import type { IServiceAccessor } from "@lcode/services";
import { resolveProjectDeletionServices } from "./projectDeletionServices.js";
import type { WorkspaceServiceResolverState } from "../lib/workspaceServiceResolver.js";

const local = {} as IServiceAccessor;
const remote = { name: "original" } as unknown as IServiceAccessor;
const other = { name: "other" } as unknown as IServiceAccessor;
const target = { workspacePath: "/same", workspaceIdentity: "original", remoteSessionId: "stale" };
const empty = () => ({
  sessionsById: { stale: { services: other } },
  sessionIdByWorkspaceIdentity: { other: "stale" },
  sessionIdByWorkspacePath: { "/same": "stale" },
});

test("offline deletion awaits reconnect and resolves the current identity service, ignoring stale session and same-path sources", async () => {
  let state: WorkspaceServiceResolverState = empty();
  const calls: string[] = [];
  const actual = await resolveProjectDeletionServices(
    target,
    local,
    () => state,
    async (key) => {
      calls.push(key);
      state = {
        ...state,
        sessionsById: { ...state.sessionsById, fresh: { services: remote } },
        sessionIdByWorkspaceIdentity: { ...state.sessionIdByWorkspaceIdentity, original: "fresh" },
      };
    },
    "offline",
  );
  assert.equal(actual, remote);
  assert.deepEqual(calls, ["original"]);
});

test("failed or incomplete reconnect rejects without borrowing local or another remote service", async () => {
  for (const reconnect of [
    undefined,
    async () => {},
    async () => {
      throw new Error("network failure");
    },
  ]) {
    await assert.rejects(
      resolveProjectDeletionServices(target, local, empty, reconnect, "offline"),
    );
  }
});

test("local deletion uses base services and connected identity does not reconnect", async () => {
  assert.equal(
    await resolveProjectDeletionServices(
      { workspacePath: "/same" },
      local,
      empty,
      undefined,
      "offline",
    ),
    local,
  );
  let reconnects = 0;
  const state = { ...empty(), sessionIdByWorkspaceIdentity: { original: "stale" } };
  assert.equal(
    await resolveProjectDeletionServices(
      target,
      local,
      () => state,
      async () => {
        reconnects++;
      },
      "offline",
    ),
    other,
  );
  assert.equal(reconnects, 0);
});
