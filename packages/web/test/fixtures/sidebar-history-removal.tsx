import { useCallback, useEffect, useState, type ComponentType } from "react";
import {
  buildRemoteWorkspaceIdentity,
  type AppSettings,
  type RemoteTarget,
  type IPlatformService,
  type ProjectMutationRequest,
  type ProjectMutationResult,
} from "@lcode/shared";
import type { IServiceAccessor } from "@lcode/services";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useRemoteWorkspaceHistory } from "@/root/useRemoteWorkspaceHistory.js";
import { useRootWorkspaceActions } from "@/root/useRootWorkspaceActions.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import type { DesktopWorkspaceReconnect } from "@/hooks/windowWorkspaceReconnect.js";
import { ChatEmptyWorkspacePreviewMenu } from "@/ChatEmptyState.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { isWorkspaceTab } from "@/store/tabStore.js";

/** 网络和磁盘桩只提供 IO，历史状态、提交顺序、失败恢复均执行真实 Root owner。 */
export function createHistoryRemovalFixture({
  enabled,
  settings,
  origin,
  target,
  defaults,
  calls,
  facts,
  registerConnected,
}: {
  enabled: boolean;
  settings: Partial<AppSettings>;
  origin: string;
  target: RemoteTarget;
  defaults: IServiceAccessor;
  calls: Array<{ method: string; params: unknown }>;
  facts: { connects: number; finishedReconnects: number };
  registerConnected?: (sessionId: string) => void;
}) {
  let rejectSave = false;
  let connectionResult: "held" | "success" | "failure" = "held";
  let finishConnection: (() => void) | undefined;
  let finishCancellation: (() => void) | undefined;
  const listeners = new Set<() => void>();
  if (enabled && !settings.lastWorkspaceSession) {
    const targets =
      target.kind === "ssh" ? [target, { ...target, host: "other.invalid" }] : [target];
    settings.lastWorkspaceSession = [
      { kind: "local", workspacePath: origin },
      ...targets.map((remoteTarget) => ({
        kind: "remote" as const,
        workspacePath: origin,
        target: remoteTarget,
        lastOpenedAt: 1,
        lastConnectionStatus: "failed" as const,
      })),
    ];
    settings.projectDefinitions = {
      version: 1,
      projects: [
        ...(settings.localProjects ?? []),
        ...targets.map((remoteTarget, index) => ({
          id: `saved-${index}`,
          name: index ? "另一台远程项目" : "保存的远程项目",
          primaryFolderPath: origin,
          sourceFolderPaths: [origin],
          workspaceIdentity: buildRemoteWorkspaceIdentity(origin, remoteTarget),
        })),
      ],
    };
  }
  return {
    reconnect:
      (onReconnect?: DesktopWorkspaceReconnect): DesktopWorkspaceReconnect =>
      async (key, options) => {
        if (!onReconnect) {
          facts.connects++;
          return;
        }
        try {
          await onReconnect(key, options);
        } finally {
          facts.finishedReconnects++;
        }
      },
    update: async (patch: Partial<AppSettings>) => {
      if (!enabled) return defaults.settingService.update(patch);
      calls.push({ method: "saveHistory", params: patch });
      if (rejectSave) throw new Error("Fixture history save failed");
      Object.assign(settings, patch);
      localStorage.setItem("sidebar-fixture-projects", JSON.stringify(settings));
    },
    mutateProject:
      (mutate: (request: ProjectMutationRequest) => Promise<ProjectMutationResult>) =>
      async (request: ProjectMutationRequest) => {
        if (enabled && rejectSave) throw new Error("Fixture project save failed");
        return mutate(request);
      },
    services: enabled
      ? {
          credentialService: {
            ...defaults.credentialService,
            load: async () => null,
            delete: async (key: string) => {
              calls.push({ method: "deleteCredential", params: key });
            },
          },
        }
      : {},
    platform: {
      onSettingsChanged: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      ...(enabled
        ? {
            connectRemote: async () => {
              facts.connects++;
              calls.push({ method: "connectRemote", params: {} });
              if (connectionResult === "failure")
                return { success: false, error: "Fixture connection refused" };
              if (connectionResult === "success") {
                registerConnected?.("reconnected");
                return { success: true, sessionId: "reconnected" };
              }
              return new Promise<{ success: false; error: string }>((resolve) => {
                finishConnection = () =>
                  resolve({ success: false, error: "Fixture late connection failure" });
              });
            },
            cancelPendingRemoteConnection: async () =>
              new Promise<void>((resolve) => {
                finishCancellation = resolve;
              }),
          }
        : {}),
    } satisfies Partial<IPlatformService>,
    notifySettingsChanged: () => {
      listeners.forEach((listener) => listener());
    },
    actions: {
      setReconnectResult: (result: typeof connectionResult) => {
        connectionResult = result;
      },
      rejectHistorySave: (reject: boolean) => {
        rejectSave = reject;
      },
      finishConnection: () => finishConnection?.(),
      finishCancellation: () => finishCancellation?.(),
    },
    tabs: (tabs: WorkspaceTabState[], opened: boolean) =>
      !enabled
        ? tabs
        : tabs
            .filter(
              (tab) =>
                !tab.remoteTarget ||
                (opened &&
                  settings.lastWorkspaceSession?.some(
                    (entry) =>
                      entry.kind === "remote" &&
                      buildRemoteWorkspaceIdentity(entry.workspacePath, entry.target) ===
                        buildRemoteWorkspaceIdentity(origin, target),
                  )),
            )
            .map((tab) => ({ ...tab, remoteSessionId: undefined })),
  };
}

export interface HistoryRemovalActions {
  onRemoveRemoteProject?: (key: string) => Promise<void>;
  onReconnect?: DesktopWorkspaceReconnect;
  onSelectLocalProject?: (path: string) => Promise<void>;
  onCreateLocalProject?: (
    request: import("@lcode/shared").LocalProjectCreateRequest,
  ) => Promise<void>;
  onOpenRemoteHistory?: (key: string) => Promise<void>;
}
export function SavedHistoryFixture({
  services,
  content: Content,
}: {
  services: IServiceAccessor;
  content: ComponentType<HistoryRemovalActions>;
}) {
  const api = useTabStoreApi();
  const { intl } = useLCodeIntl();
  const platform = usePlatform();
  const { settings: observedSettings } = useSettings(services);
  const [restored, setRestored] = useState(false);
  const activateTabByPath = useCallback(
    (...args: Parameters<ReturnType<typeof api.getState>["activateTabByPath"]>) =>
      api.getState().activateTabByPath(...args),
    [api],
  );
  const addTab = useCallback(
    (...args: Parameters<ReturnType<typeof api.getState>["addTab"]>) => {
      return api.getState().addTab(...args);
    },
    [api],
  );
  const { handleRemoveLocalProject, handleSelectProject, handleCreateLocalProject } =
    useRootWorkspaceActions({
      intl,
      services,
      platform,
      tabStoreApi: api,
      addTab,
      activeWorkspacePath: null,
      activeWorkspaceIdentity: null,
      supportsSettings: true,
      allowOpenWorkspace: true,
      preferDirectoryBrowser: false,
      refreshProviderState: async () => {},
      updateAppSettings: async () => {},
      setOAuthError: () => {},
      setUser: () => {},
    });
  const {
    restorePersistedSession,
    handleRemoveRemoteProject,
    handleReconnectRemoteWorkspace,
    handleOpenRemoteWorkspaceFromHistory,
  } = useRemoteWorkspaceHistory({
    intl,
    services,
    platform,
    supportsSettings: true,
    tabStoreApi: api,
    activateTabByPath,
    addTab,
    onRemoveProjectDefinition: handleRemoveLocalProject,
  });
  useEffect(() => {
    let cancelled = false;
    void services.settingService.get().then(async (current) => {
      if (cancelled) return;
      await restorePersistedSession(current);
      if (!cancelled) setRestored(true);
    });
    return () => {
      cancelled = true;
    };
  }, [restorePersistedSession, services]);
  return restored ? (
    <>
      {new URLSearchParams(location.search).has("project-navigation") ? (
        <div data-testid="project-readd-picker">
          <ChatEmptyWorkspacePreviewMenu
            workspacePath="/fixture/conversations"
            localProjects={
              observedSettings?.projectDefinitions?.projects ??
              observedSettings?.localProjects ??
              []
            }
            workspaceTabs={api.getState().tabs.filter(isWorkspaceTab)}
            onSelectWorkspace={(tab) =>
              void handleSelectProject(tab.workspacePath, { localProjectId: tab.localProjectId })
            }
            onSelectConversationWorkspace={() => {}}
            onConnectRemote={async () => "remote"}
            onSelectRemoteProject={async () => {}}
            onCancelRemoteProject={async () => {}}
          />
        </div>
      ) : null}
      <Content
        onRemoveRemoteProject={handleRemoveRemoteProject}
        onReconnect={handleReconnectRemoteWorkspace}
        onSelectLocalProject={handleSelectProject}
        onCreateLocalProject={handleCreateLocalProject}
        onOpenRemoteHistory={handleOpenRemoteWorkspaceFromHistory}
      />
    </>
  ) : null;
}
