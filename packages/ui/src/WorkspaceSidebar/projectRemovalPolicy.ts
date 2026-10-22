export type ProjectRemovalBlockedReason =
  | "activeExecutionSet"
  | "dependentChats"
  | "activeBinding"
  | "verifySource";

/** 离线允许发起删除，由动作在确认后重连并权威校验；已知依赖仍保留门禁。 */
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
  if (facts.isRemote && !facts.sourceConnected) return undefined;
  if (facts.sourceLoading || facts.sourceUnavailable) return "verifySource";
  return undefined;
}
