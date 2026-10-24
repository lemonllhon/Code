import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { GitChangeSourceId } from "@lcode/shared";
import { useGitRepository, type GitPaneRepositoryState } from "../hooks/useGitRepository.js";
import { useGitAutoRefresh } from "../hooks/useGitAutoRefresh.js";
import { useSessionGitLastTurn } from "../hooks/useSessionGitLastTurn.js";
import type { SidePaneToolWindowOwner } from "../lib/sidePaneToolWindow.js";

/** 独立 Git 使用原 scope 的读取投影；刷新不依赖主窗口当前项目，也不改变导航。 */
export function SidePaneGitState({
  detached,
  owner,
  executionPath,
  executionIdentity,
  gitState,
  selectedSourceId,
  onSelectSource,
  onRefresh,
  children,
}: {
  detached: boolean;
  owner: SidePaneToolWindowOwner;
  executionPath: string;
  executionIdentity?: string;
  gitState: GitPaneRepositoryState;
  selectedSourceId: GitChangeSourceId;
  onSelectSource: (source: GitChangeSourceId) => void;
  onRefresh: () => void;
  children: (state: {
    gitState: GitPaneRepositoryState;
    selectedSourceId: GitChangeSourceId;
    onSelectSource: (source: GitChangeSourceId) => void;
    onRefresh: () => void;
  }) => ReactNode;
}) {
  const [revision, setRevision] = useState(0);
  const [source, setSource] = useState(selectedSourceId);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const lastTurn = useSessionGitLastTurn({
    workspacePath: owner.workspacePath,
    workspaceIdentity: owner.workspaceIdentity,
    remoteSessionId: owner.remoteSessionId,
    sessionId: owner.sessionId,
    executionWorkspacePath: executionPath,
    enabled: detached,
    refreshToken: revision,
  });
  const repository = useGitRepository({
    workspacePath: executionPath,
    workspaceIdentity: executionIdentity,
    activeTaskId: owner.sessionId,
    remoteSessionId: owner.remoteSessionId,
    enabled: detached,
    includeExtendedData: true,
    lastTurnDataset: lastTurn,
    refreshToken: revision,
  });
  useGitAutoRefresh({
    workspacePath: executionPath,
    workspaceIdentity: executionIdentity,
    remoteSessionId: owner.remoteSessionId,
    gitSummary: repository.summary,
    gitSummaryWorkspaceKey: repository.workspaceKey,
    enabled: detached,
    livePanelVisible: detached,
    onRefreshGit: refresh,
  });
  const wasDetached = useRef(detached);
  useEffect(() => {
    if (wasDetached.current && !detached) onSelectSource(source);
    wasDetached.current = detached;
  }, [detached, onSelectSource, source]);
  return children({
    gitState: detached && repository.revision > 0 ? repository : gitState,
    selectedSourceId: detached ? source : selectedSourceId,
    onSelectSource: detached ? setSource : onSelectSource,
    onRefresh: detached ? refresh : onRefresh,
  });
}
