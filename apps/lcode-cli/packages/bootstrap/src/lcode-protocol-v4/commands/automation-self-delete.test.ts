import assert from "node:assert/strict";
import test from "node:test";
import type { TurnBackgroundAttribution } from "@lcode/contracts";
import { startPromptTurn } from "./prompt-turn.js";
import type { V4SessionRecordView } from "./types.js";

for (const identity of ["explicit", "run-id"] as const) {
  test(`V4 ${identity} admission permits self-deletion and clears attribution after completion`, async () => {
    const done = Promise.withResolvers<void>();
    let admitted: Record<string, unknown> | undefined;
    const record = {
      persistence: "immediate",
      app: {
        sessionId: "session-fixture",
        sendInput: async (_input: unknown, options: Record<string, unknown>) => {
          admitted = options;
          return { kind: "started", completion: done.promise };
        },
      },
    } as unknown as V4SessionRecordView;
    const host = { getRecord: () => record };
    const attribution: TurnBackgroundAttribution =
      identity === "explicit" ? { automationId: "automation-self" } : {};
    const result = await startPromptTurn(host, record, {
      content: "finish and delete this automation",
      inputId: "automation-self:run-fixture",
      ...attribution,
      toolDisallowlist: ["Bash"],
    });
    assert.equal(record.activeAutomationId, "automation-self");
    assert.equal(admitted?.automationId, "automation-self");
    assert.deepEqual(admitted?.toolDisallowlist, ["Bash", "CronCreate", "CronUpdate"]);
    done.resolve();
    await result.completion;
    assert.equal(record.activeAutomationId, undefined);
    await startPromptTurn(host, record, { content: "user input", inputId: "user-fixture" });
    assert.equal(admitted?.automationId, undefined);
    assert.equal(admitted?.toolDisallowlist, undefined);
  });
}

test("V4 retains explicit caller deletion denial", async () => {
  let tools: unknown;
  const record = {
    app: {
      sendInput: async (_: unknown, options: { toolDisallowlist: unknown }) => {
        tools = options.toolDisallowlist;
        return { kind: "queued" };
      },
    },
  } as unknown as V4SessionRecordView;
  await startPromptTurn({ getRecord: () => record }, record, {
    content: "restricted",
    inputId: "automation-self:run",
    toolDisallowlist: ["CronDelete"],
  });
  assert.deepEqual(tools, ["CronDelete", "CronCreate", "CronUpdate"]);
  assert.equal(record.activeAutomationId, undefined);
});
