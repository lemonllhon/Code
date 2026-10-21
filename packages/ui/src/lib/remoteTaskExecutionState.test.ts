import assert from "node:assert/strict";
import test from "node:test";
import type { WindowHostControllerTaskListItem } from "@lcode/services";
import { getRemoteTaskExecutionState } from "./remoteTaskExecutionState.js";
import { attachTaskListRowActivity } from "../v4/taskListRowActivity.js";

const task: WindowHostControllerTaskListItem = {
  taskId: "task",
  traceId: "trace" as never,
  title: "task",
  mode: "build",
  workspacePath: "/repo",
  workspaceIdentity: "remote",
  createdAt: 1,
  updatedAt: 2,
  status: "running",
  sourceAvailability: "online",
  liveStatus: "running",
};

test("remote task status requires live activity for running and distinguishes background work", () => {
  assert.equal(getRemoteTaskExecutionState(task), "syncing");
  for (const [phase, background, expected] of [
    ["draft", false, null],
    ["prewarming", false, "preparing"],
    ["running", false, "running"],
    ["completedSuccess", true, "background"],
    ["completedSuccess", false, "completed"],
    ["completedInterrupted", false, "interrupted"],
    ["error", true, "failed"],
  ] as const) {
    const live = attachTaskListRowActivity(task, {
      phase,
      lastActivityAt: 2,
      hasBackgroundWork: background,
    });
    assert.equal(getRemoteTaskExecutionState(live), expected);
    const offline = { ...live, sourceAvailability: "offline" as const };
    assert.equal(getRemoteTaskExecutionState(offline), "offline");
  }
});

test("waiting keeps the existing interaction badge; historical terminal states remain readable", () => {
  assert.equal(
    getRemoteTaskExecutionState(
      attachTaskListRowActivity(task, {
        phase: "running",
        lastActivityAt: 2,
        hasBackgroundWork: false,
        pendingInteractions: { permissionCount: 1, userInputCount: 0 },
      }),
    ),
    null,
  );
  assert.equal(getRemoteTaskExecutionState({ ...task, status: "completed" }), "completed");
  assert.equal(getRemoteTaskExecutionState({ ...task, status: "error" }), "failed");
  assert.equal(getRemoteTaskExecutionState({ ...task, workspaceIdentity: undefined }), null);
});
