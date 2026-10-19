import assert from "node:assert/strict";
import test from "node:test";
import { ToolScheduler, type ToolDependency } from "./scheduler.js";

const read = (id: string): ToolDependency => ({
  toolCallId: id as never,
  toolName: "Read",
  dependsOn: [],
  readOnly: true,
  concurrentSafe: true,
  sideEffectScope: "none",
});
test("parallel stages retain barriers and do not split at the concurrency limit", () => {
  const scheduler = new ToolScheduler({ maxConcurrency: 2 });
  const schedule = scheduler.schedule([
    read("A"),
    read("B"),
    read("C"),
    {
      ...read("write"),
      toolName: "Write",
      readOnly: false,
      concurrentSafe: false,
      sideEffectScope: "workspace",
    },
    read("after"),
  ]);
  assert.deepEqual(schedule.parallelGroups, [["A", "B", "C"], ["write"], ["after"]]);
});
test("approval, interaction and terminal tools are isolated even when marked concurrentSafe", () => {
  for (const flag of [
    "needsApproval",
    "requiresUserInteraction",
    "stopTurnOnSuccess",
    "alwaysAsk",
  ] as const) {
    assert.deepEqual(
      new ToolScheduler().schedule([
        read("before"),
        { ...read("barrier"), [flag]: true },
        read("after"),
      ]).parallelGroups,
      [["before"], ["barrier"], ["after"]],
    );
  }
});
