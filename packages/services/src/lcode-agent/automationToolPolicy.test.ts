import assert from "node:assert/strict";
import test from "node:test";
import { mergeAutomationMutationToolDenylist } from "./automationToolPolicy.js";

test("automation dispatch hides creation and updates but leaves self-deletion available", () => {
  assert.deepEqual(mergeAutomationMutationToolDenylist(undefined), ["CronCreate", "CronUpdate"]);
});

test("automation dispatch preserves explicit caller restrictions and deduplicates", () => {
  assert.deepEqual(mergeAutomationMutationToolDenylist(["Bash", "CronDelete", "CronCreate"]), [
    "Bash",
    "CronDelete",
    "CronCreate",
    "CronUpdate",
  ]);
});
