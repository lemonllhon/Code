import assert from "node:assert/strict";
import test from "node:test";
import { createCommandFailure } from "./commandFailure.js";

test("command failures retain the server detail and reason without exposing an empty or duplicate message", () => {
  assert.equal(
    createCommandFailure(
      {
        reasonCode: "fault.command.executionFailed",
        message: "Method not found: executeProjectNative",
      },
      "Send failed",
    ).message,
    "fault.command.executionFailed: Method not found: executeProjectNative",
  );
  assert.equal(
    createCommandFailure({ reasonCode: "guard.rejected" }, "Send failed").message,
    "guard.rejected",
  );
  assert.equal(
    createCommandFailure({ reasonCode: "guard.rejected", message: "guard.rejected" }, "Send failed")
      .message,
    "guard.rejected",
  );
  assert.equal(
    createCommandFailure({ reasonCode: "  ", message: " " }, "Send failed").message,
    "Send failed",
  );
});
