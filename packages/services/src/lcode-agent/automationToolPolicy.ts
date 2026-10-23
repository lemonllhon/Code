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

// 独立常量，绝不并入 AUTOMATION_MUTATION_TOOL_NAMES——cron automation 轮
