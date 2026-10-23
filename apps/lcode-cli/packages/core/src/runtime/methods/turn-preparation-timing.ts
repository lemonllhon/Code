type PreparationStage = "compaction" | "project_memory" | "session_history" | "git_context" | "mcp";

export interface TurnPreparationSummary {
  durationMs: number;
  status: "completed" | "failed" | "cancelled";
  stages: Partial<Record<PreparationStage, number>>;
}

/** 只观察原准备链路，不并行化依赖、不保存上下文或改变错误传播。 */
export async function runTimedTurnPreparation(options: {
  steps: ReadonlyArray<readonly [PreparationStage, () => Promise<unknown>]>;
  ensureActive: () => void;
  signal: AbortSignal;
  onSlow?: (summary: TurnPreparationSummary) => void;
  now?: () => number;
}): Promise<void> {
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const stages: TurnPreparationSummary["stages"] = {};
  let completed = false;
  try {
    for (const [stage, run] of options.steps) {
      options.ensureActive();
      const stageStartedAt = now();
      try {
        await run();
      } finally {
        stages[stage] = Math.max(0, Math.round(now() - stageStartedAt));
      }
      options.ensureActive();
    }
    completed = true;
  } finally {
    const durationMs = Math.max(0, Math.round(now() - startedAt));
    if (durationMs >= 1000 && options.onSlow) {
      try {
        options.onSlow({
          durationMs,
          stages,
          status: completed ? "completed" : options.signal.aborted ? "cancelled" : "failed",
        });
      } catch {
        // 诊断失败不能覆盖原请求或取消结果；摘要仅含数字耗时与固定状态。
      }
    }
  }
}
