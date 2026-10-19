import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import type { SessionConfigState } from "@lcode/shared/lcode-protocol-v4";

/** 只消费明确审批事实；重复快照不能把用户后来改回的权限再刷成 yolo。 */
export function applyComposerPermissionGrant(
  draft: V4ComposerDraft,
  grant: SessionConfigState["permissionGrant"],
  currentMode?: string,
): V4ComposerDraft {
  if (!grant || draft.lastPermissionGrantId === grant.interactionId) return draft;
  // 旧 Host 可能保留历史授权标记；当前执行事实已降权时，不能把菜单刷回历史 yolo。
  if (currentMode !== undefined && (grant.mode ?? "yolo") !== currentMode) return draft;
  // 授权是用户明确选择；否则新任务默认刷新会在下一次渲染把已确认权限改回旧值。
  return {
    ...draft,
    mode: grant.mode ?? "yolo",
    approvalModeEdited: true,
    initializeFromNewTask: undefined,
    lastPermissionGrantId: grant.interactionId,
  };
}
