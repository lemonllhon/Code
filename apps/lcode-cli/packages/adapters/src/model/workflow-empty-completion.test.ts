import assert from "node:assert/strict";
import test from "node:test";
import { ModelErrorCode, ModelFailureReason, ModelRetryBudget } from "@lcode/contracts";
import { classifyModelFailure } from "./failure-classifier.js";
import { exhaustedEmptyCompletionError } from "./empty-completion-retry.js";
import {
  retryAllowedByFailurePolicy,
  inspectWorkflowModelFailure,
  resolveWorkflowModelFailurePolicy,
} from "./workflow-model-failure-policy.js";
import { AiSdkModelAdapterError } from "./errors.js";
test("workflow shares the exhausted empty-response decision at both retry and driver boundaries", () => {
  const failure = classifyModelFailure(exhaustedEmptyCompletionError());
  assert.equal(retryAllowedByFailurePolicy(failure, ModelRetryBudget.Unbounded, undefined), false);
  const error = new AiSdkModelAdapterError(ModelErrorCode.InvalidModelResponse, "fixture", {
    context: {
      reason: ModelFailureReason.InvalidRequest,
      retryable: false,
      retryBudgetExhausted: true,
    },
  });
  assert.equal(
    retryAllowedByFailurePolicy(classifyModelFailure(error), ModelRetryBudget.Unbounded, undefined),
    false,
  );
  assert.deepEqual(inspectWorkflowModelFailure(error)?.policy, { decision: "stop", kind: "other" });
  assert.deepEqual(
    resolveWorkflowModelFailurePolicy(
      {
        code: ModelErrorCode.InvalidModelResponse,
        reason: ModelFailureReason.InvalidRequest,
        retryable: false,
      },
      undefined,
    ),
    { decision: "retry" },
  );
});
