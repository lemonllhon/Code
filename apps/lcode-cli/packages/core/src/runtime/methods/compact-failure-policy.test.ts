import assert from "node:assert/strict";
import test from "node:test";
import { canRecoverCompactModelFailure } from "./compact-failure-policy.js";
import { compactActiveConversation } from "./compact-active.js";
import { createMockRuntime } from "./lint-runtime-fixture.js";
import { CompactTrigger } from "../deps.js";

test("compression cannot restart terminal requests or exhausted adapter budgets", () => {
  for (const error of [
    { context: { retryable: false } },
    { retryable: false },
    { context: { retryBudgetExhausted: true, retryable: true } },
    { context: { retryDisposition: "terminal" } },
    { context: { retryDisposition: "exhausted" } },
  ])
    assert.equal(canRecoverCompactModelFailure(error), false);
  assert.equal(canRecoverCompactModelFailure(new Error("transient fixture")), true);
  assert.equal(canRecoverCompactModelFailure({ context: { retryable: true } }), true);
});

for (const context of [{ retryable: false }, { retryable: true, retryBudgetExhausted: true }]) {
  test(`auto compact does not replace transport or repeat a finished failure (${JSON.stringify(context)})`, async () => {
    let streamCalls = 0,
      generateCalls = 0;
    const failure = Object.assign(new Error("fixture terminal adapter failure"), { context });
    const { runtime, model } = createMockRuntime({}, () => ({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            streamCalls++;
            throw failure;
          },
        };
      },
    }));
    model.generateText = async () => {
      generateCalls++;
      throw failure;
    };
    for (let i = 0; i < 4; i++) {
      runtime.messageHistory.addUser(`fixture ${i}`);
      runtime.messageHistory.addAssistant(`answer ${i}`);
    }
    const original = JSON.stringify(runtime.messageHistory.borrowReadOnlyRuntimeEntries());
    await assert.rejects(
      compactActiveConversation.call(runtime, undefined, runtime.rootTraceContext, [], {
        model,
        trigger: CompactTrigger.Auto,
      }),
      (error) => error === failure,
    );
    assert.equal(streamCalls, 1);
    assert.equal(generateCalls, 0);
    assert.equal(JSON.stringify(runtime.messageHistory.borrowReadOnlyRuntimeEntries()), original);
  });
}
