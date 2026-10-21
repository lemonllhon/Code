import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IBroadcastService, IGitService, IServiceAccessor } from "@lcode/services";
import type { GitNetworkOperation, GitStashSnapshot } from "@lcode/shared";
import { GitReviewSidePane } from "@/app-shell/GitReviewSidePane.js";
import { ChatEmptyCreateProjectDialog } from "@/ChatEmptyCreateProjectDialog.js";
import { ChatEmptyWorkspacePreviewMenu } from "@/ChatEmptyState.js";
import { GitManagementSection } from "@/settings/GitManagementSection.js";
import { gitManagementService, gitManagementControls } from "./git-management-service.js";
import { services as defaults } from "./sidebar-file-tree-service.js";
import {
  commitReviewNavigationKey,
  useCommitReviewNavigationStore,
  type GitWorkbenchView,
} from "@/store/commitReviewNavigationStore.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { StoreProvider, useLCodeStore } from "@/store/StoreProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { platform } from "./git-backup-platform.js";
import "@lcode/ui/styles.css";

const root = "/fixture/repo",
  oid = "a".repeat(40),
  revision = "b".repeat(64);
const state = {
  headCommitHash: "c".repeat(40),
  branchName: "main",
  indexFingerprint: revision,
  worktreeFingerprint: revision,
};
const entry = {
  oid,
  selector: "stash@{0}",
  subject: "On main: preserve local changes / 工作区改动",
  timestamp: 1792458000,
};
const calls: { host: string; method: string; params: any }[] = [];
let hold = false,
  lost = false,
  conflict = false,
  unknown = false,
  nested = false,
  release: (() => void) | null = null;
const wait = async () => {
  if (hold)
    await new Promise<void>((resolve) => {
      release = resolve;
    });
};
function service(host: string) {
  const receipts = new Map<string, GitNetworkOperation>();
  let snapshot: GitStashSnapshot = { revision, entries: [entry], blocked: false, operation: null };
  const call = (method: string, params: any) => {
    calls.push({ host, method, params });
  };
  return {
    getStashSnapshot: async (params: unknown) => {
      call("snapshot", params);
      return structuredClone(snapshot);
    },
    getNetworkOperation: async (params: { requestId: string }) => {
      call("receipt", params);
      return receipts.get(params.requestId) ?? null;
    },
    getPublishState: async (params: unknown) => {
      call("state", params);
      await wait();
      return state;
    },
    previewStashSave: async (params: { includeUntracked: boolean }) => {
      call("savePreview", params);
      await wait();
      return {
        root,
        expectedState: state,
        revision,
        files: params.includeUntracked ? ["src/app.ts", "empty.txt"] : ["src/app.ts"],
      };
    },
    previewStash: async (params: any) => {
      call("stashPreview", params);
      return {
        oid: params.oid,
        revision,
        sections: ["staged", "unstaged", "untracked"].map((source) => ({
          source,
          patch: `diff --git a/${source}.txt b/${source}.txt\n+${source} change`,
          truncated: false,
        })),
      };
    },
    previewRepositoryAcquisition: async (params: any) => {
      call("importPreview", params);
      await wait();
      return {
        revision,
        mode: params.mode,
        targetPath:
          params.mode === "init"
            ? params.workspacePath
            : `${params.workspacePath}/${params.targetName}`,
        parentRepository: nested ? "/fixture/parent" : null,
      };
    },
    previewGitOperationCompletion: async (params: any) => {
      call("recoveryPreview", params);
      return {
        sourceRequestId: params.requestId,
        targetPath: root,
        revision,
        conflicts: conflict ? ["src/app.ts"] : [],
        canComplete: !conflict,
        needsNativeConfirmation: snapshot.operation?.status === "unknown",
      };
    },
    ...Object.fromEntries(
      ["saveStash", "applyStash", "dropStash", "acquireRepository", "completeGitOperation"].map(
        (method) => [
          method,
          async (params: any) => {
            call(method, params);
            await wait();
            const receipt: GitNetworkOperation = {
              requestId: params.requestId,
              kind:
                method === "saveStash"
                  ? "stash-save"
                  : method === "applyStash"
                    ? "stash-apply"
                    : method === "dropStash"
                      ? "stash-drop"
                      : method === "completeGitOperation"
                        ? "reconcile"
                        : params.options.mode === "init"
                          ? "repository-init"
                          : "repository-clone",
              status:
                method === "applyStash" && unknown
                  ? "unknown"
                  : conflict && method === "applyStash"
                    ? "conflict"
                    : "success",
              startedAt: "2026-10-20T01:00:00.000Z",
              targetPath: method === "acquireRepository" ? params.preview.targetPath : root,
            };
            if (method === "applyStash") {
              receipt.stashOid = params.oid;
              if (unknown) snapshot = { ...snapshot, blocked: true, operation: receipt };
              if (conflict) {
                receipt.code = "stash-conflict";
                receipt.conflicts = [
                  {
                    path: "src/app.ts",
                    stages: [
                      { stage: 1, mode: "100644", oid },
                      { stage: 2, mode: "100644", oid },
                      { stage: 3, mode: "100644", oid },
                    ],
                  },
                ];
                snapshot = { ...snapshot, blocked: true, operation: receipt };
              }
            }
            if (method === "saveStash")
              snapshot = {
                ...snapshot,
                entries: [
                  {
                    ...entry,
                    oid: "d".repeat(40),
                    selector: "stash@{0}",
                    subject: params.message || "saved",
                  },
                  { ...entry, selector: "stash@{1}" },
                ],
              };
            if (method === "dropStash")
              snapshot = {
                ...snapshot,
                entries: snapshot.entries.filter((item) => item.oid !== params.oid),
              };
            if (method === "completeGitOperation") {
              receipt.resolved = true;
              snapshot = { ...snapshot, blocked: false, operation: null };
            }
            receipts.set(params.requestId, receipt);
            if (lost) {
              lost = false;
              throw new Error("fixture-lost-ack");
            }
            return receipt;
          },
        ],
      ),
    ),
  } as unknown as IGitService;
}
const local = {
    ...defaults,
    gitManagementService,
    gitService: service("local"),
    sidebarOrganizationService: {
      getSnapshot: async () => ({
        version: 1,
        revision: 0,
        sections: [{ id: "tools", title: "工具", entries: [] }],
        rootOrders: [],
        importedSources: [],
      }),
      onDidChange: () => ({ dispose() {} }),
    },
  } as IServiceAccessor,
  remote = { gitService: service("remote") } as IServiceAccessor;
const registry = useRemoteWorkspaceSessionStore.getState();
registry.registerBaseServices(local);
registry.registerSession({ sessionId: "fixture-remote", services: remote });
registry.bindWorkspaceIdentity("fixture:remote", "fixture-remote");
const broadcast = {
  send: async () => {},
  onMessage: () => ({ dispose() {} }),
} as IBroadcastService;
let failRegistration = false;
const registrationRequests: unknown[] = [];
let selectedGitFile: string | null = "/fixture/custom/git",
  failGitPicker = false;
let selectedProjectFolders: string[] = [];
const openedGitPaths: string[] = [];
const gitPlatform = {
  ...platform,
  selectDirectories: async () => selectedProjectFolders.splice(0),
  canSelectFilePath: new URLSearchParams(location.search).has("native"),
  selectFile: async () => {
    if (failGitPicker) {
      failGitPicker = false;
      throw new Error("fixture-picker-failed");
    }
    return selectedGitFile;
  },
  openInFileManager: async (path: string) => {
    openedGitPaths.push(path);
    return { success: path !== "/fixture/missing" };
  },
};
function Fixture() {
  const [managementOpen, setManagementOpen] = useState(
    new URLSearchParams(location.search).has("management"),
  );
  const theme = useLCodeStore((s) => s.setTheme);
  useEffect(() => {
    theme(new URLSearchParams(location.search).has("dark") ? "zai-dark" : "zai-light");
  }, [theme]);
  const [identity, setIdentity] = useState<string>(),
    [view, setView] = useState<GitWorkbenchView>("changes"),
    [project, setProject] = useState(false),
    [created, setCreated] = useState("");
  const key = commitReviewNavigationKey(identity || root, undefined, "fixture-session");
  useEffect(() => {
    useCommitReviewNavigationStore.getState().registerPaneNavigation(key, {
      token: "fixture",
      open: () => setView("review"),
      close: () => {},
      selectView: setView,
    });
    return () => useCommitReviewNavigationStore.getState().removePaneNavigation(key, "fixture");
  }, [key]);
  Object.assign(globalThis, {
    __gitWorkspace: {
      calls,
      management: gitManagementControls,
      selectProjectFolders: (paths: string[]) => {
        selectedProjectFolders = paths;
      },
      selectedGitFile: (value: string | null) => {
        selectedGitFile = value;
      },
      failGitPicker: () => {
        failGitPicker = true;
      },
      openedGitPaths: () => openedGitPaths,
      failRegistration: () => {
        failRegistration = true;
      },
      registrationRequests: () => registrationRequests,
      hold: () => {
        hold = true;
      },
      release: () => {
        hold = false;
        release?.();
      },
      lostAck: () => {
        lost = true;
      },
      unknown: () => {
        unknown = true;
      },
      conflict: (value: boolean) => {
        conflict = value;
      },
      nested: () => {
        nested = true;
      },
      remote: () => setIdentity("fixture:remote"),
      disconnect: () => registry.unregisterSession("fixture-remote"),
    },
  });
  return (
    <main
      className={`flex h-dvh min-w-0 flex-col border-r border-border bg-background text-foreground ${managementOpen ? "w-full" : "max-w-lg"}`}
    >
      <ChatEmptyWorkspacePreviewMenu
        workspacePath={root}
        workspaceTabs={[]}
        onSelectWorkspace={() => {}}
        onSelectConversationWorkspace={() => {}}
        onConnectRemote={async () => "remote"}
        onSelectRemoteProject={async () => {}}
        onCancelRemoteProject={async () => {}}
        onCreateLocalProject={async (request) => {
          registrationRequests.push(request);
          if (failRegistration) {
            failRegistration = false;
            throw new Error("fixture-registration-failure");
          }
          setCreated(JSON.stringify(request));
        }}
      />
      <button data-testid="git-settings-toggle" onClick={() => setManagementOpen(!managementOpen)}>
        Git settings
      </button>
      {managementOpen ? (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <GitManagementSection />
        </div>
      ) : (
        <>
          <button data-testid="project-open" onClick={() => setProject(true)}>
            Create project
          </button>
          <div className="min-h-0 flex-1">
            <GitReviewSidePane
              workspaceKey={identity || root}
              sessionId="fixture-session"
              workspacePath={root}
              workspaceIdentity={identity}
              workspaceRemoteSessionId={identity ? "fixture-remote" : undefined}
              view={view}
              visible
            >
              <p>Changes</p>
            </GitReviewSidePane>
          </div>
        </>
      )}
      <ChatEmptyCreateProjectDialog
        open={project}
        onOpenChange={setProject}
        onCreate={async (request) => {
          setCreated(JSON.stringify(request));
        }}
      />
      <output data-testid="project-created">{created}</output>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={local}>
    <PlatformProvider platform={gitPlatform}>
      <LCodeIntlProvider
        initialLocale={new URLSearchParams(location.search).has("english") ? "en-US" : "zh-CN"}
      >
        <TooltipProvider>
          <TabStoreProvider>
            <StoreProvider broadcastService={broadcast}>
              <Fixture />
            </StoreProvider>
          </TabStoreProvider>
        </TooltipProvider>
      </LCodeIntlProvider>
    </PlatformProvider>
  </ServiceProvider>,
);
