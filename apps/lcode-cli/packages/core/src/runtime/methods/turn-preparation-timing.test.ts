import assert from "node:assert/strict";
import test from "node:test";
import { runTimedTurnPreparation, type TurnPreparationSummary } from "./turn-preparation-timing.js";

test("preparation preserves order and reports only slow work with numeric stage durations", async () => {
  let now = 0;
  const order: string[] = [];
  const summaries: TurnPreparationSummary[] = [];
  const run = async (duration: number) =>
    runTimedTurnPreparation({
      steps: [
        [
          "compaction",
          async () => {
            order.push("compaction");
            now += 10;
          },
        ],
        [
          "git_context",
          async () => {
            order.push("git");
            now += duration;
          },
        ],
        [
          "mcp",
          async () => {
            order.push("mcp");
            now += 20;
          },
        ],
      ],
      ensureActive: () => {},
      signal: new AbortController().signal,
      now: () => now,
      onSlow: (summary) => summaries.push(summary),
    });
  await run(200);
  assert.deepEqual(summaries, []);
  await run(2000);
  assert.deepEqual(order, ["compaction", "git", "mcp", "compaction", "git", "mcp"]);
  assert.deepEqual(summaries, [
    {
      durationMs: 2030,
      status: "completed",
      stages: { compaction: 10, git_context: 2000, mcp: 20 },
    },
  ]);
});

test("failed preparation records the failed stage and preserves the original exception", async () => {
  let now = 0;
  const failure = new Error("fixture failure");
  const summaries: TurnPreparationSummary[] = [];
  await assert.rejects(
    runTimedTurnPreparation({
      steps: [
        [
          "project_memory",
          async () => {
            now += 1200;
            throw failure;
          },
        ],
        [
          "mcp",
          async () => {
            assert.fail("must not initialize after failure");
          },
        ],
      ],
      ensureActive: () => {},
      signal: new AbortController().signal,
      now: () => now,
      onSlow: (summary) => summaries.push(summary),
    }),
    (error) => error === failure,
  );
  assert.deepEqual(summaries, [
    { durationMs: 1200, status: "failed", stages: { project_memory: 1200 } },
  ]);
});

test("cancellation stops later stages and cannot be masked by a diagnostic failure", async () => {
  let now = 0;
  const controller = new AbortController();
  const aborted = new Error("fixture abort");
  let summary: TurnPreparationSummary | undefined;
  await assert.rejects(
    runTimedTurnPreparation({
      steps: [
        [
          "session_history",
          async () => {
            now += 1000;
            controller.abort(aborted);
          },
        ],
        [
          "git_context",
          async () => {
            assert.fail("must not read after abort");
          },
        ],
      ],
      ensureActive: () => controller.signal.throwIfAborted(),
      signal: controller.signal,
      now: () => now,
      onSlow: (value) => {
        summary = value;
        throw new Error("fixture logger failure");
      },
    }),
    (error) => error === aborted,
  );
  assert.equal(summary?.status, "cancelled");
  assert.deepEqual(summary?.stages, { session_history: 1000 });
});

test("diagnostics cannot fail a successful turn and can be omitted for subsequent steps", async () => {
  let now = 0;
  const steps = [
    [
      "mcp",
      async () => {
        now += 1200;
      },
    ],
  ] as const;
  await runTimedTurnPreparation({
    steps,
    ensureActive: () => {},
    signal: new AbortController().signal,
    now: () => now,
    onSlow: () => {
      throw new Error("logger");
    },
  });
  await runTimedTurnPreparation({
    steps,
    ensureActive: () => {},
    signal: new AbortController().signal,
    now: () => now,
  });
});
