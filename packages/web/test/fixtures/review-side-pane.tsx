import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { GitPaneRepositoryState } from "@/hooks/useGitRepository.js";
import { useAppPanels } from "@/hooks/useAppPanels.js";
import { useServices } from "@/hooks/useServices.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useNarrowWebLayout } from "@/hooks/useNarrowWebLayout.js";
import { AnimatedSidePanePanel } from "@/app-shell/AnimatedSidePanePanel.js";
import { useAnimatedResizablePanel } from "@/app-shell/useAnimatedResizablePanel.js";
import { ResizablePanel } from "@/components/ui/resizable.js";
import {
  WorkspaceShellSurface,
  WorkspaceBodyPanelGroup,
} from "@/app-shell/WorkspaceShellSurface.js";

const noop = () => {};
const gitState = {
  summary: {
    workspacePath: "/fixture/repo",
    repoRoot: "/fixture/repo",
    workspaceInRepoPath: ".",
    autoRefreshWatchPaths: [],
    branchName: "main",
    trackingBranchName: null,
    headRefType: "branch",
    ahead: 0,
    behind: 0,
    isDirty: false,
    isGitAvailable: true,
    isRepository: true,
  },
  identity: {
    userName: "Fixture",
    userEmail: "fixture@example.invalid",
    nameSource: null,
    emailSource: null,
    scopeLabel: null,
  },
  placeholder: { enabled: false },
  loading: false,
  error: null,
  revision: 0,
  workspaceKey: "/fixture/repo",
  sourceOptions: [{ id: "unstaged", count: 0, readonly: false, disabled: false }],
  datasets: {
    unstaged: { id: "unstaged", readonly: false, sections: [], loading: false, error: null },
  },
} as GitPaneRepositoryState;

/** 服务事实用桩；导航、标签页归属、显示筛选、抽屉与 PreviewPane 均运行生产实现。 */
export function FixtureReviewSidePane({
  workspacePath,
  workspaceIdentity,
  executionPath,
  executionIdentity,
  remoteSessionId,
  sessionId,
  onSource,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  executionPath: string;
  executionIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
  onSource?: (source: CodeViewerSource | null) => void;
}) {
  const services = useServices();
  const platform = usePlatform();
  const narrow = useNarrowWebLayout(false);
  const panels = useAppPanels({
    workspaceAbsPath: workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId: remoteSessionId,
    activeTaskId: sessionId,
    sidePaneOwnerId: sessionId,
    isDesktop: false,
    isNarrowWebLayout: narrow,
    defaultWhiteboardNamePrefix: "Fixture",
    platform,
  });
  const side = useAnimatedResizablePanel({
    open: !panels.isSidePaneCollapsed,
    expandedSize: narrow ? "100%" : "75%",
    resizeOnInitialVisibleMount: false,
    resizeEnabled: !narrow,
  });
  const tab = panels.sidePaneState?.tabs.find(
    (item) => item.id === panels.sidePaneState?.activeTabId,
  );
  onSource?.(tab?.type === "code-viewer" ? tab.source : null);
  return (
    <div
      // 独立 fixture 的状态卡不在生产 conversation 列内；外层须匹配真实抽屉 z-40，
      // 否则卡片 z-20 会跨过测试壳遮挡 Git 子导航，制造生产布局没有的点击失败。
      style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 40 }}
      data-testid="fixture-review-side-pane"
    >
      <style>
        {
          '[data-testid="fixture-review-side-pane"] [data-workspace-side-pane-panel], [data-testid="fixture-review-side-pane"] [role="dialog"] { pointer-events: auto; }'
        }
      </style>
      <WorkspaceShellSurface isNarrowWebLayout={narrow} isNativeDesktop={false}>
        <WorkspaceBodyPanelGroup isNarrowWebLayout={narrow}>
          <ResizablePanel id="conversation-column" defaultSize="25%" minSize="0px" />
          <AnimatedSidePanePanel
            services={services}
            isDesktop={false}
            isVisible={narrow ? !panels.isSidePaneCollapsed : side.isVisible}
            isNarrowWebLayout={narrow}
            onCloseSidePane={panels.handleCloseSidePane}
            sidePaneState={panels.sidePaneState}
            recentClosedSidePaneTabs={panels.recentClosedSidePaneTabs}
            isBrowserOpen={false}
            supportsEmbeddedBrowser={false}
            ownerWorkspaceKey={workspaceIdentity?.trim() || workspacePath}
            ownerWorkspacePath={workspacePath}
            ownerWorkspaceIdentity={workspaceIdentity}
            getSidePaneTab={panels.getSidePaneTab}
            onSelectGitTabView={panels.handleSelectGitTabView}
            workspaceAbsPath={executionPath}
            workspaceIdentity={executionIdentity}
            workspaceRemoteSessionId={remoteSessionId}
            activeTaskId={sessionId}
            sidePaneOwnerId={sessionId}
            gitState={gitState}
            activeGitSourceId="unstaged"
            panelRef={side.panelRef}
            panelElementRef={side.panelElementRef}
            onPanelResize={side.onPanelResize}
            browserNavigationRequest={null}
            browserRestoreUrls={{}}
            fileChangeFindActiveIndex={0}
            fileChangeFindNavigationRequestId={0}
            fileChangeFindQuery=""
            onFileChangeFindMatchCountChange={noop}
            onCloseCodeViewer={panels.handleCloseCodeViewer}
            onCloseGit={panels.handleCloseGit}
            onActivateTab={panels.handleActivateSidePaneTab}
            onReorderTab={panels.handleReorderSidePaneTab}
            onCloseTab={panels.handleCloseSidePaneTab}
            onCloseOtherTabs={panels.handleCloseOtherSidePaneTabs}
            onCloseAllTabs={panels.handleCloseAllSidePaneTabs}
            onReopenClosedTab={panels.handleReopenClosedSidePaneTab}
            onOpenBrowserTab={noop}
            onOpenWhiteboard={noop}
            onOpenDeveloperTools={noop}
            onOpenTerminalTab={noop}
            onOpenReviewTab={noop}
            onOpenSelectionSideConversation={noop}
            onOpenBrowserUrl={noop}
            onOpenCodeViewer={panels.handleOpenCodeViewer}
            onOpenSubagentSession={noop}
            onRefreshGit={noop}
            onBrowserNavigationRequestHandled={noop}
            onBrowserUrlChange={noop}
            onBrowserPageMetadataChange={noop}
            onSelectGitSource={noop}
          />
        </WorkspaceBodyPanelGroup>
      </WorkspaceShellSurface>
    </div>
  );
}
