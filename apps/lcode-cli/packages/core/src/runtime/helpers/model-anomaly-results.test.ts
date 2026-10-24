import assert from "node:assert/strict";
import test from "node:test";
import { detectRepeatedToolCallWarnings } from "./model-anomaly.js";
import type { ModelToolCall, ToolExecutionResult } from "../deps.js";

function observer() {
  const state = { anomalyWarningsInjected: 0, repeatedToolCallStreakCount: 0 };
  return (output: unknown, success = true, missing = false, name = "Read") => {
    const call = { id: "fixture", name, input: { path: "file" } } as ModelToolCall;
    const result = {
      toolCallId: "fixture",
      toolName: name,
      output,
      success,
      durationMs: Math.random() * 100,
      startedAt: new Date(),
      completedAt: new Date(),
      ...(success ? {} : { error: { type: "cancelled", message: "cancelled" } }),
    } satisfies ToolExecutionResult;
    return detectRepeatedToolCallWarnings(
      [call],
      state,
      { repeatedToolCallWarningThreshold: 3 },
      missing ? [] : [result],
    );
  };
}
test("same inputs with changing results progress; unchanged results warn without stopping the loop", () => {
  const observe = observer();
  for (let i = 0; i < 20; i++) assert.deepEqual(observe(`progress ${i}`), []);
  assert.deepEqual(observe("same"), []);
  assert.deepEqual(observe("same"), []);
  assert.equal(observe("same")[0]?.warningInjected, true);
  for (let i = 0; i < 10; i++) assert.deepEqual(observe("same"), []);
});
test("failure, missing completion, and real output changes reset the streak; shell timing noise does not", () => {
  const observe = observer();
  observe("same");
  observe("same");
  assert.deepEqual(observe("same", false), []);
  assert.deepEqual(observe("same", true, true), []);
  assert.deepEqual(observe("same"), []);
  const shell = observer();
  shell("Wall time: 1 second\nChunk ID: a\nresult", true, false, "Bash");
  shell("Wall time: 2 seconds\nChunk ID: b\nresult", true, false, "Bash");
  assert.equal(
    shell("Wall time: 3 seconds\nChunk ID: c\nresult", true, false, "Bash")[0]?.warningInjected,
    true,
  );
});
