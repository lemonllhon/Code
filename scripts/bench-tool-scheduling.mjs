import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";
import { ToolRegistryImpl } from "../apps/lcode-cli/packages/core/src/tool/registry.js";
import { ToolScheduler } from "../apps/lcode-cli/packages/core/src/tool/scheduler.js";
import { createToolExecutor } from "../apps/lcode-cli/packages/core/src/tool/executor/impl.js";

const durations = [60, 5, 5, 60];
const tools = durations.map((ms, index) => ({ id: `call-${index}`, name: "Read", input: { ms } }));
const percentile = (values, fraction) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
async function sample(mode) {
  let active = 0,
    maximum = 0;
  const registry = new ToolRegistryImpl();
  registry.register({
    metadata: {
      name: "Read",
      readOnly: true,
      concurrentSafe: true,
      destructive: false,
      needsApproval: false,
      sideEffectScope: "none",
      riskLevel: "low",
    },
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    handler: async ({ ms }) => {
      maximum = Math.max(maximum, ++active);
      try {
        await setTimeout(ms);
        return { ms };
      } finally {
        active--;
      }
    },
  });
  const executor = createToolExecutor({
    registry,
    maxConcurrency: 2,
    permissionService: { checkPermission: () => ({ allowed: true, decision: "allow" }) },
    emitEvent: async () => {},
    sessionId: "fixture",
    getMode: () => "yolo",
  });
  const schedule = new ToolScheduler({ maxConcurrency: 2 }).schedule(
    tools.map((tool) => ({
      toolCallId: tool.id,
      toolName: tool.name,
      dependsOn: [],
      readOnly: true,
      concurrentSafe: true,
      sideEffectScope: "none",
    })),
  );
  // 对照复现旧 scheduler 的固定两项波次；两组均使用当前真实 executor、权限和结果序列化。
  if (mode === "fixed-waves")
    schedule.parallelGroups = [
      ["call-0", "call-1"],
      ["call-2", "call-3"],
    ];
  const start = performance.now();
  const execution = executor.executeSchedule(tools, schedule);
  let results;
  while (true) {
    const next = await execution.next();
    if (next.done) {
      results = next.value;
      break;
    }
  }
  const durationMs = performance.now() - start;
  assert.deepEqual(
    results.map((result) => result.toolCallId),
    tools.map((tool) => tool.id),
  );
  assert.ok(results.every((result) => result.success));
  assert.equal(maximum, 2);
  assert.equal(active, 0);
  return durationMs;
}
const results = [];
for (const mode of ["fixed-waves", "refill"]) {
  for (let i = 0; i < 5; i++) await sample(mode);
  const samples = [];
  for (let i = 0; i < 20; i++) samples.push(await sample(mode));
  results.push({
    mode,
    samples: 20,
    warmups: 5,
    durationsMs: durations,
    concurrency: 2,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    p99Ms: percentile(samples, 0.99),
  });
}
const result = {
  node: process.version,
  platform: process.platform,
  baseline: "fixed-wave schedule model, same real executor and controlled handlers; no network",
  results,
};
console.log(JSON.stringify(result, null, 2));
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2) + "\n");
