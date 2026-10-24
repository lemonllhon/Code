import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IBroadcastService, IServiceAccessor } from "@lcode/services";
import { openDesktopToolWindow } from "../../../desktop/src/renderer/src/desktopToolWindow.js";
import { desktopBrowserPlatformBridge } from "../../../desktop/src/renderer/src/desktopBrowserPlatformBridge.js";
import type { IPlatformService } from "@lcode/shared";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { AnimatedSidePanePanel } from "@/app-shell/AnimatedSidePanePanel.js";
import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable.js";
import { useAnimatedResizablePanel } from "@/app-shell/useAnimatedResizablePanel.js";
import { useGitRepository } from "@/hooks/useGitRepository.js";
import { useAppPanels } from "@/hooks/useAppPanels.js";
import { notifyTaskLifecycle } from "@/lib/taskLifecycleEvents.js";
import { readTaskSidePaneMemoryState } from "@/lib/taskSidePaneMemory.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { services as baseServices, origin } from "./git-session-refresh-runtime.js";
import { GitActionMenu } from "@/GitActionMenu.js";
import { RetainedGitActionMenuProvider } from "@/git-action-menu/RetainedGitActionMenu.js";
import { createReviewWorkspaceFixture } from "./review-workspace-service.js";
import { platform as base } from "./git-backup-platform.js";
import "@/styles.css";

const noop = () => {};
const services: IServiceAccessor = {
  ...baseServices,
  gitService: {
    ...baseServices.gitService,
    ...createReviewWorkspaceFixture(),
    getDiff: async ({ path }) => ({
      path,
      availability: "patch",
      patch: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      beforeContent: "old",
      afterContent: "new",
    }),
    refresh: async (request) => ({
      ...(await baseServices.gitService.refresh(request)),
      identity: {
        userName: "Fixture",
        userEmail: "fixture@example.invalid",
        nameSource: "fixture",
        emailSource: "fixture",
      },
      unstagedChanges: [
        {
          path: "a.ts",
          repoRelativePath: "a.ts",
          workspaceRelativePath: "a.ts",
          kind: "modified",
          section: "unstaged",
          added: 1,
          removed: 0,
          isStaged: false,
          isUntracked: false,
          isConflicted: false,
        },
      ],
    }),
  },
};
const platform: IPlatformService = {
  ...base,
  ...desktopBrowserPlatformBridge,
  openToolWindow: openDesktopToolWindow,
  onBrowserViewScreenshotSurfacePrepare: (handler) =>
    window.lcode.onBrowserViewScreenshotSurfacePrepare?.(handler) ?? noop,
  onBrowserViewScreenshotSurfaceRelease: (handler) =>
    window.lcode.onBrowserViewScreenshotSurfaceRelease?.(handler) ?? noop,
  browserViewScreenshotSurfaceReady: (payload) =>
    window.lcode.browserViewScreenshotSurfaceReady?.(payload),
};
const paths = [origin, "/fixture/project-b"];
const broadcast = { send: async () => {}, onMessage: () => noop } as IBroadcastService;
useRemoteWorkspaceSessionStore.getState().registerBaseServices(services);

function Fixture() {
  const [workspace, setWorkspace] = useState(origin);
  const [task, setTask] = useState("chat-a");
  const [summary, setSummary] = useState<
    Awaited<ReturnType<typeof services.gitService.refresh>>["summary"] | null
  >(null);
  useEffect(() => {
    void services.gitService
      .refresh({ workspacePath: workspace })
      .then((result) => setSummary(result.summary));
  }, [workspace]);
  const panels = useAppPanels({
    workspaceAbsPath: workspace,
    activeTaskId: task,
    sidePaneOwnerId: task,
    isDesktop: true,
    defaultWhiteboardNamePrefix: "Fixture",
    platform,
  });
  const side = useAnimatedResizablePanel({
    open: !panels.isSidePaneCollapsed,
    expandedSize: "50%",
    rememberExpandedSize: true,
  });
  const git = useGitRepository({ enabled: false, workspacePath: workspace, activeTaskId: task });
  const label = workspace === origin ? "Project A" : "Project B";
  Object.assign(window, {
    toolOwnerFixture: {
      switch: (path: string, task: string) => {
        setWorkspace(path);
        setTask(task);
      },
      state: () => ({ workspace, task }),
      hasGit: (path: string) =>
        (path === workspace
          ? panels.sidePaneState
          : readTaskSidePaneMemoryState(path).sidePaneState
        )?.tabs.some((tab) => tab.type === "git") ?? false,
      openGit: panels.handleOpenGit,
      deleteTask: (workspaceKey: string, taskId: string) =>
        notifyTaskLifecycle({ type: "deleted", workspaceKey, taskId }),
      currentTab: () => panels.sidePaneState?.activeTabId,
      hasTab: (path: string, id: string) => Boolean(panels.getSidePaneTab(path, id)),
      openEphemeralFile: () =>
        panels.handleOpenCodeViewer({
          type: "text",
          title: "Delete me.txt",
          content: "Will be deleted",
          language: "text",
        }),
    },
  });
  return (
    <ResizablePanelGroup direction="horizontal" className="h-screen">
      <ResizablePanel id="conversation" minSize="30%">
        <p data-testid="active-owner">
          {label} · {task}
        </p>
        <button onClick={panels.handleOpenGit}>Open Git</button>
        <GitActionMenu
          key={JSON.stringify([workspace, task])}
          workspacePath={workspace}
          executionSessionId={task}
          dialogScopeKey={task}
          gitSummary={summary}
          onRefreshGit={noop}
        />
        <button
          onClick={() =>
            panels.handleOpenCodeViewer({
              type: "text",
              title: `${label}.txt`,
              content: `${label} retained content`,
              language: "text",
            })
          }
        >
          Open file
        </button>
        <button
          onClick={() =>
            panels.handleOpenBrowserUrl(`${location.origin}/test/fixtures/tool-window-page.html`)
          }
        >
          Open browser
        </button>
      </ResizablePanel>
      <AnimatedSidePanePanel
        services={services}
        isDesktop
        isVisible={side.isVisible}
        sidePaneState={panels.sidePaneState}
        recentClosedSidePaneTabs={panels.recentClosedSidePaneTabs}
        isBrowserOpen
        supportsEmbeddedBrowser
        ownerWorkspaceKey={workspace}
        ownerWorkspacePath={workspace}
        workspaceAbsPath={workspace}
        projectName={label}
        activeTaskTitle={task}
        activeTaskId={task}
        sidePaneOwnerId={task}
        getSidePaneTab={panels.getSidePaneTab}
        onSelectGitTabView={panels.handleSelectGitTabView}
        openWorkspaceKeys={paths}
        onLocateToolWindowOwner={(owner) => {
          setWorkspace(owner.workspacePath);
          setTask(owner.sessionId ?? "draft");
        }}
        gitState={git}
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
        onOpenTerminalTab={panels.handleOpenTerminalTab}
        onOpenReviewTab={panels.handleOpenGit}
        onOpenSelectionSideConversation={noop}
        onOpenBrowserUrl={panels.handleOpenBrowserUrl}
        onOpenCodeViewer={panels.handleOpenCodeViewer}
        onOpenSubagentSession={panels.handleOpenSubagentSession}
        onRefreshGit={noop}
        onBrowserNavigationRequestHandled={panels.handleBrowserNavigationRequestHandled}
        onBrowserUrlChange={noop}
        onBrowserPageMetadataChange={panels.handleBrowserPageMetadataChange}
        onSelectGitSource={noop}
        onCloseSidePane={panels.handleCloseSidePane}
      />
    </ResizablePanelGroup>
  );
}
createRoot(document.getElementById("root")!).render(
  <PlatformProvider platform={platform}>
    <ServiceProvider services={services}>
      <StoreProvider broadcastService={broadcast}>
        <TabStoreProvider>
          <LCodeIntlProvider initialLocale="zh-CN">
            <TooltipProvider>
              <RetainedGitActionMenuProvider>
                <Fixture />
              </RetainedGitActionMenuProvider>
            </TooltipProvider>
          </LCodeIntlProvider>
        </TabStoreProvider>
      </StoreProvider>
    </ServiceProvider>
  </PlatformProvider>,
);
