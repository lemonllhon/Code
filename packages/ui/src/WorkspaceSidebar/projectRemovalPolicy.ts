export type ProjectRemovalBlockedReason =
  | "activeExecutionSet"
  | "dependentChats"
  | "activeBinding"
  | "verifySource";

/** 永久删除必须能验证来源；离线项目仍可归档，不把断连接口关闭伪装为彻底删除。 */
export function projectRemovalBlockedReason(facts: {
  hasExecutionSets: boolean;
  hasIndependentChats: boolean;
  hasWorktrees: boolean;
  isRemote: boolean;
  sourceConnected: boolean;
  sourceLoading: boolean;
  sourceUnavailable: boolean;
}): ProjectRemovalBlockedReason | undefined {
  if (facts.hasExecutionSets) return "activeExecutionSet";
  // 永久删除会一并清理独立放置的会话及组织引用，不能沿用旧“移除入口”的依赖门禁。
  if (facts.hasWorktrees) return "activeBinding";
  if (facts.isRemote && !facts.sourceConnected) return "verifySource";
  if (facts.sourceLoading || facts.sourceUnavailable) return "verifySource";
  return undefined;
}
