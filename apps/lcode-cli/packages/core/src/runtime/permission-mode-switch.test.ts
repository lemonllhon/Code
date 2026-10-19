import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEvent, SessionEntryInfo } from "@lcode/contracts";
import type { AgentRuntimeInternal } from "./internal.js";
import { grantPermissionFullAccess, setPermissionMode } from "./permission-full-access.js";
import { restorePermissionGrantMarker } from "./helpers/permission-grant-resume.js";
import { applySubmissionExecutionState } from "./methods/turn-model.js";

function fixture() {
  const entries: SessionEntryInfo[] = [],
    events: SessionEvent[] = [],
    commits: unknown[] = [];
  const pending = [{ id: "queued", intent: { mode: "build", planEnabled: true } }];
  let failCommit = false,
    failPublish = false;
  const runtime = {
    sessionId: "fixture",
    config: { mode: "build", planEnabled: true },
    rootTraceContext: { traceId: "trace" },
    pendingInputReservations: new Map(),
    activeTurn: { pendingInputs: pending },
    rebuildProjection: async () => ({
      pendingSteerInputs: pending.map((item) => ({ pendingInputId: item.id })),
    }),
    sessionStore: {
      sessionEntries: async () => entries,
      commitPermissionFullAccess: async (input: { receipt: SessionEntryInfo }) => {
        if (failCommit) throw Error("commit failed");
        commits.push(input);
        entries.push(input.receipt);
      },
    },
    eventStore: { getEvents: async () => events },
    createEvent: (type: string, payload: unknown) => ({
      id: `event-${entries.length}`,
      sessionId: "fixture",
      type,
      payload,
      timestamp: new Date(),
      traceId: "trace",
      sequenceNumber: 0,
    }),
    appendEvent: async (event: SessionEvent) => {
      if (failPublish) throw Error("publish failed");
      events.push(event);
    },
    notifyEventSinks: async () => {},
  } as unknown as AgentRuntimeInternal;
  return {
    runtime,
    pending,
    entries,
    events,
    commits,
    failCommit: () => {
      failCommit = true;
    },
    failPublish: (value: boolean) => {
      failPublish = value;
    },
  };
}

test("menu modes and full-access dialog share one atomic owner and preserve Plan", async () => {
  const f = fixture();
  await grantPermissionFullAccess.call(f.runtime, "dialog");
  await setPermissionMode.call(f.runtime, "edit", "menu-edit");
  assert.equal(f.runtime.config.mode, "edit");
  assert.equal(f.runtime.config.planEnabled, true);
  assert.equal(f.pending[0]!.intent.mode, "edit");
  assert.deepEqual(
    f.commits.map((input) => (input as { mode: string }).mode),
    ["yolo", "edit"],
  );
  assert.equal(f.runtime.lastPermissionGrantMode, "edit");
  f.runtime.getSessionModelSelection = () => undefined;
  await applySubmissionExecutionState(
    f.runtime,
    f.pending[0]!.intent as never,
    f.runtime.rootTraceContext,
  );
  assert.equal(
    f.runtime.config.mode,
    "edit",
    "draining a previously admitted input must not restore build",
  );
});

test("resume and a published receipt retry never resurrect an obsolete full-access marker", async () => {
  const f = fixture();
  await grantPermissionFullAccess.call(f.runtime, "dialog");
  f.runtime.config.mode = "build";
  await restorePermissionGrantMarker(f.runtime, f.runtime.rootTraceContext);
  assert.equal(f.runtime.lastPermissionGrantId, undefined);
  await grantPermissionFullAccess.call(f.runtime, "dialog");
  assert.equal(f.runtime.config.mode, "build");
});

test("commit failure never updates effective mode or publishes success", async () => {
  const f = fixture();
  f.failCommit();
  await assert.rejects(setPermissionMode.call(f.runtime, "yolo", "failed"), /commit failed/);
  assert.equal(f.runtime.config.mode, "build");
  assert.equal(f.pending[0]!.intent.mode, "build");
  assert.equal(f.events.length, 0);
  assert.equal(f.runtime.permissionFullAccessPending, false);
});

test("publish retry uses frozen receipt, never expands authorization to later queued inputs", async () => {
  const f = fixture();
  f.failPublish(true);
  await assert.rejects(setPermissionMode.call(f.runtime, "yolo", "retry"), /publish failed/);
  f.pending.push({ id: "later", intent: { mode: "build", planEnabled: true } });
  f.failPublish(false);
  await setPermissionMode.call(f.runtime, "yolo", "retry");
  assert.equal(f.commits.length, 1);
  assert.equal(f.pending[1]!.intent.mode, "build");
  assert.equal(f.events.length, 1);
  await setPermissionMode.call(f.runtime, "build", "newer");
  await setPermissionMode.call(f.runtime, "yolo", "retry");
  assert.equal(f.runtime.config.mode, "build");
});
