import assert from "node:assert/strict";
import test from "node:test";
import { sendPrompt } from "./server-operations.js";
import type {
  LCodeProtocolAgentServerContext,
  LCodeProtocolSessionRecord,
} from "./server-types.js";

for (const identity of ["explicit", "run-id"] as const) {
  test(`legacy ${identity} admission forwards trusted identity and preserves caller restrictions`, async () => {
    const admitted = Promise.withResolvers<Record<string, unknown>>();
    const completion = Promise.withResolvers<void>();
    const record = {
      taskType: "interactive",
      stateRevision: 0,
      workspace: { workspacePath: "/fixture/project" },
      app: {
        sessionId: "session-fixture",
        sendInput: async (_input: unknown, options: Record<string, unknown>) => {
          admitted.resolve(options);
          return { kind: "started_turn", completion: completion.promise };
        },
      },
    } as unknown as LCodeProtocolSessionRecord;
    const context = {
      sessions: new Map([["session-fixture", record]]),
      deps: {},
      notify: () => {},
    } as unknown as LCodeProtocolAgentServerContext;
    try {
      const result = await sendPrompt(context, {
        sessionId: "session-fixture",
        content: "finish",
        inputId: "automation-self:run-fixture",
        ...(identity === "explicit" ? { automationId: "automation-self" } : {}),
        toolDenylist: ["Bash"],
      });
      assert.equal(result.accepted, true);
      const options = await admitted.promise;
      assert.equal(options.automationId, "automation-self");
      assert.deepEqual(options.toolDisallowlist, ["Bash", "CronCreate", "CronUpdate"]);
      assert.equal(record.activeAutomationId, "automation-self");
    } finally {
      completion.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(record.activeAutomationId, undefined);
    assert.equal(record.activeAbortController, undefined);
  });
}
