import { createOpenInEditorRemoteTarget } from "@lcode/shared";
import { useMemo } from "react";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab, type WindowTabState, type WorkspaceTabState } from "@/store/tabStore.js";

interface WorkspaceOpenInEditorScope {
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}

function resolveWorkspaceOpenInEditorTarget(
  tabs: readonly WindowTabState[],
  scope: WorkspaceOpenInEditorScope,
) {
  if (!scope.workspacePath) {
    return { isRemoteWorkspace: false, remoteTarget: undefined };
  }

  const requestedIdentity = scope.workspaceIdentity?.trim() || undefined;
  const requestedRemoteSessionId = scope.workspaceRemoteSessionId?.trim() || undefined;
  const workspaceKey = requestedIdentity || scope.workspacePath;
  const matches = tabs.filter((tab): tab is WorkspaceTabState => {
    if (!isWorkspaceTab(tab) || tab.workspacePath !== scope.workspacePath) {
      return false;
    }

    const tabWorkspaceKey = tab.workspaceIdentity?.trim() || tab.workspacePath;
    const tabRemoteSessionId = tab.remoteSessionId?.trim() || undefined;
    return (
      (!requestedIdentity || tabWorkspaceKey === workspaceKey) &&
      (!requestedRemoteSessionId || tabRemoteSessionId === requestedRemoteSessionId)
    );
  });
  // 本地和远端可以使用同一路径；无远端身份的本地 tab 必须先匹配，
  // 否则 SSH/WSL 候选会把本地会话误判为远程，禁用文件菜单或打开错误目标。
  const localMatches =
    !requestedIdentity && !requestedRemoteSessionId
      ? matches.filter(
          (tab) =>
            !tab.workspaceIdentity?.trim() && !tab.remoteSessionId?.trim() && !tab.remoteTarget,
        )
      : [];
  const candidates = localMatches.length ? localMatches : matches;
  // 远程文件动作以前只携带 Linux path，renderer 无法判断它属于哪个 SSH/WSL 目标；
  // identity/session 已提供时精确匹配，旧调用仅在工作区匹配唯一时提取既有脱敏目标。
  const matchedTab = candidates.length === 1 ? candidates[0] : undefined;
  const hasRemoteMatch = candidates.some((tab) =>
    Boolean(tab.workspaceIdentity?.trim() || tab.remoteSessionId?.trim() || tab.remoteTarget),
  );
  const remoteTarget = matchedTab?.remoteTarget;
  return {
    isRemoteWorkspace: hasRemoteMatch,
    remoteTarget: remoteTarget ? createOpenInEditorRemoteTarget(remoteTarget) : undefined,
  };
}

export function useWorkspaceOpenInEditorTarget(scope: WorkspaceOpenInEditorScope) {
  const tabs = useOptionalTabStore((state) => state.tabs);

  return useMemo(
    () => resolveWorkspaceOpenInEditorTarget(tabs, scope),
    [scope.workspaceIdentity, scope.workspacePath, scope.workspaceRemoteSessionId, tabs],
  );
}
