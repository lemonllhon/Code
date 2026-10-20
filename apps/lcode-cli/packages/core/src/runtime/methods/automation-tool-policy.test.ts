import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTurnDisallowedTools,
  isAutomationMutationRestrictedTurn,
  type RegularTurnLoopState,
} from "./turn-loop-state.js";
import { cronDeleteToolEntry } from "../../tool/handlers/cron.js";
import type { ToolExecutionContext } from "../../tool/types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { drainInlineGuideForNextRequest } from "./turn-guide-drain.js";

for (const attribution of [
  { turnTraceContext: { queryId: "automation-self:run" } },
  { toolDisallowlist: ["CronCreate", "CronUpdate"] },
] as const) {
  test(`unidentified scheduled turn cannot infer deletion authority from ${JSON.stringify(attribution)}`, async () => {
    const state = { turnTraceContext: {}, ...attribution } as unknown as RegularTurnLoopState;
    assert.equal(isAutomationMutationRestrictedTurn(state), true);
    const hidden = buildTurnDisallowedTools(state)!;
    assert.equal(hidden.has("CronCreate"), true);
    assert.equal(hidden.has("CronUpdate"), true);
    assert.equal(hidden.has("CronDelete"), false);
    let called = false;
    await assert.rejects(
      cronDeleteToolEntry.handler({ id: "automation-self" }, {
        automationTurn: isAutomationMutationRestrictedTurn(state),
        automationId: state.automationId,
        automationPort: {
          delete: async () => {
            called = true;
            return true;
          },
        },
      } as unknown as ToolExecutionContext),
      /only delete itself/i,
    );
    assert.equal(called, false);
  });
}

test("draining another automation's guide cannot replace the current turn's deletion authority", async () => {
  const state = {
    automationId: "automation-original",
    activeTurn: {},
    modelSelectionScope: "execution",
    turnRequestState: { entries: [] },
    turnTraceContext: {},
    events: [],
    toolDisallowlist: ["Bash"],
  } as unknown as RegularTurnLoopState;
  const runtime = {
    hasInlineGuidePendingInput: () => true,
    drainPendingInput: async () => ({
      pendingInputIds: ["input-guide"],
      queryIds: ["automation-other:run"],
      runtimeEntries: [],
      toolDisallowlist: ["CronCreate", "CronUpdate"],
    }),
  } as unknown as AgentRuntimeInternal;
  assert.equal(await drainInlineGuideForNextRequest(runtime, state), true);
  assert.equal(isAutomationMutationRestrictedTurn(state), true);
  assert.equal(state.automationId, "automation-original");
  assert.equal(state.turnTraceContext.queryId, "automation-other:run");
  assert.deepEqual([...buildTurnDisallowedTools(state)!], ["Bash", "CronCreate", "CronUpdate"]);
  const deleted: string[] = [];
  const context = {
    automationTurn: isAutomationMutationRestrictedTurn(state),
    automationId: state.automationId,
    automationPort: {
      delete: async ({ id }: { id: string }) => {
        deleted.push(id);
        return true;
      },
    },
  } as unknown as ToolExecutionContext;
  await assert.rejects(
    cronDeleteToolEntry.handler({ id: "automation-other" }, context),
    /only delete itself/i,
  );
  await cronDeleteToolEntry.handler({ id: "automation-original" }, context);
  assert.deepEqual(deleted, ["automation-original"]);
});

test("explicit deletion denial remains effective alongside automatic restrictions", () => {
  const state = {
    automationId: "automation-self",
    turnTraceContext: {},
    toolDisallowlist: ["CronDelete"],
  } as unknown as RegularTurnLoopState;
  assert.deepEqual(
    [...buildTurnDisallowedTools(state)!],
    ["CronDelete", "CronCreate", "CronUpdate"],
  );
});
