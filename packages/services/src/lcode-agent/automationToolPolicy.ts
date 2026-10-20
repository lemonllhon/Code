// 原来把删除也整体隐藏，自动化无法在完成后停止自身；删除范围由可信本轮身份校验。
export const AUTOMATION_MUTATION_TOOL_NAMES = ["CronCreate", "CronUpdate"] as const;

export function mergeAutomationMutationToolDenylist(
  current: readonly string[] | undefined,
): string[] {
  const merged = new Set(current);
  for (const toolName of AUTOMATION_MUTATION_TOOL_NAMES) {
    merged.add(toolName);
  }
  return [...merged];
}

// 闲时派发轮只 deny OffPeakCreate（防止闲时任务递归自我派生、无限调度），OffPeakList 只读保留。
// 独立常量，绝不并入 AUTOMATION_MUTATION_TOOL_NAMES——cron automation 轮
// 明确放行 OffPeakCreate（定时派生闲时任务），混入会让 automation 轮误 deny。
export const OFF_PEAK_MUTATION_TOOL_NAMES = ["OffPeakCreate"] as const;

export function mergeOffPeakMutationToolDenylist(current: readonly string[] | undefined): string[] {
  const merged = new Set(current);
  for (const toolName of OFF_PEAK_MUTATION_TOOL_NAMES) {
    merged.add(toolName);
  }
  return [...merged];
}
