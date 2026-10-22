import assert from "node:assert/strict";
import test from "node:test";
import { ToolSchemaCompatibilityError } from "@lcode/provider";
import { workerFailure } from "./worker-error.mjs";
test("worker retains the local compiler's terminal contract without exposing arbitrary context", () => {
  const failure = workerFailure(new ToolSchemaCompatibilityError("mixed union"), {});
  assert.equal(failure.code, "invalid_model_request");
  assert.equal(failure.context.retryable, false);
  assert.equal(
    workerFailure(
      Object.assign(new Error("fixture"), { context: { private: "fixture-secret" } }),
      {},
    ).context,
    undefined,
  );
});
