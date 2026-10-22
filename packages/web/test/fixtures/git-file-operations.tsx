import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { IBroadcastService, IGitService, IServiceAccessor } from "@lcode/services";
import type { GitChangeSourceId, GitPublishState } from "@lcode/shared";
import { GitPane } from "@/GitPane.js";
import { BranchProbe } from "./git-file-operations-branch.js";
import { createFileRefreshProbe } from "./git-file-operations-refresh.js";
import { useGitRepository } from "@/hooks/useGitRepository.js";
import { useGitAutoRefresh } from "@/hooks/useGitAutoRefresh.js";
import type { GitPaneFileChange, GitPaneRepositoryState } from "@/hooks/useGitRepository.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { DiffsWorkerPoolProvider } from "@/root/DiffsWorkerPoolProvider.js";
import { platform } from "./git-backup-platform.js";
import "@lcode/ui/styles.css";

const root = "/fixture/repo";
const params = new URLSearchParams(location.search);
const live = params.has("live");
if (params.has("dark")) document.documentElement.className = "dark theme-zai-dark";
const change = (name: string, staged = false): GitPaneFileChange => ({
  path: `${root}/${name}`,
  repoRelativePath: name,
  workspaceRelativePath: name,
  kind: "modified",
  section: staged ? "staged" : "unstaged",
  isStaged: staged,
  added: 1,
  removed: 1,
  diff: null,
});
let unstaged = [
  change("src/中文 file.ts"),
  { ...change("new.txt"), isUntracked: true, section: "untracked" as const },
];
let staged = [change("other.ts", true)];
if (params.has("many")) {
  unstaged = Array.from({ length: 50 }, (_, index) =>
    change(index === 0 ? "src/中文 file.ts" : `src/file-${index}.ts`),
  );
}
let version = 0;
const snapshot = (): GitPublishState => ({
  headCommitHash: "a".repeat(40),
  branchName: "main",
  indexFingerprint: String(version).padStart(64, "0"),
  worktreeFingerprint: String(version).padStart(64, "0"),
});
const branchSummary = {
  workspacePath: root,
  repoRoot: root,
  workspaceInRepoPath: ".",
  autoRefreshWatchPaths: [{ path: `${root}/.git`, recursive: true }],
  branchName: "main",
  trackingBranchName: null,
  headRefType: "branch" as const,
  ahead: 0,
  behind: 0,
  isDirty: true,
  isGitAvailable: true,
  isRepository: true,
};
const refreshProbe = createFileRefreshProbe(
  root,
  () => ({
    summary: branchSummary,
    identity: null,
    unstagedChanges: unstaged,
    stagedChanges: staged,
    branchComparison: null,
  }),
  params.get("os") ?? "win32",
);
const calls: { host: string; method: string; params: unknown }[] = [];
let hold = false;
let release: (() => void) | null = null;
let fail = false;
let busy = false;
const makeService = (host: string) =>
  ({
    refresh: refreshProbe.refresh,
    getLocalBranches: async () => ({
      branches: [],
      currentBranchName: "main",
      headRefType: "branch",
    }),
    getChanges: async ({ sourceId }: { sourceId: string }) =>
      sourceId === "staged" ? staged : unstaged,
    getIdentity: async () => ({ userName: "Fixture", userEmail: "fixture@example.invalid" }),
    switchBranch: async (params: unknown) => {
      calls.push({ host, method: "switchBranch", params });
      return {
        ok: false,
        action: "switch",
        branchName: "topic",
        didChange: false,
        created: false,
        summary: branchSummary,
        issues: [
          {
            code: "tracked-changes-would-be-overwritten",
            message: "blocked",
            paths: ["src/中文 file.ts"],
          },
        ],
      };
    },
    commitAndSwitchBranch: async (params: unknown) => {
      calls.push({ host, method: "commitAndSwitchBranch", params });
      return {
        commit: { commitHash: "b".repeat(40), summary: branchSummary },
        switchResult: {
          ok: false,
          branchName: "topic",
          action: "switch",
          summary: branchSummary,
          issues: [{ code: "target-branch-not-found", message: "missing" }],
        },
      };
    },
    getPublishState: async (params: unknown) => {
      calls.push({ host, method: "state", params });
      if (hold)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return snapshot();
    },
    getDiff: refreshProbe.getDiff,
    ...Object.fromEntries(
      ["stagePaths", "unstagePaths", "discardPaths"].map((method) => [
        method,
        async (params: { paths: string[]; expectedState: GitPublishState }) => {
          calls.push({ host, method, params });
          if (busy) throw new Error("Checkout is busy");
          if (fail) throw new Error("fixture write failed");
          if (params.expectedState.indexFingerprint !== snapshot().indexFingerprint)
            throw new Error("Git 内容已变化，请重新确认");
          if (method === "stagePaths") {
            const selected = unstaged.filter((file) =>
              params.paths.includes(file.workspaceRelativePath),
            );
            staged.push(
              ...selected.map((file) => ({ ...file, isStaged: true, section: "staged" as const })),
            );
            unstaged = unstaged.filter((file) => !selected.includes(file));
          } else if (method === "unstagePaths") {
            const selected = staged.filter((file) =>
              params.paths.includes(file.workspaceRelativePath),
            );
            unstaged.push(
              ...selected.map((file) => ({
                ...file,
                isStaged: false,
                section: "unstaged" as const,
              })),
            );
            staged = staged.filter((file) => !selected.includes(file));
          } else {
            unstaged = unstaged.filter(
              (file) => !params.paths.includes(file.workspaceRelativePath),
            );
            staged = staged.filter((file) => !params.paths.includes(file.workspaceRelativePath));
          }
          version++;
        },
      ]),
    ),
  }) as unknown as IGitService;
const makeServices = (host: string) =>
  ({
    gitService: makeService(host),
    ...refreshProbe.services,
  }) as unknown as IServiceAccessor;
const local = makeServices("local");
const remote = makeServices("remote");
const registry = useRemoteWorkspaceSessionStore.getState();
registry.registerBaseServices(local);
registry.registerSession({ sessionId: "fixture-remote", services: remote });
registry.bindWorkspaceIdentity("fixture:remote", "fixture-remote");
const broadcast = {
  send: async () => {},
  onMessage: () => ({ dispose() {} }),
} as IBroadcastService;

function Fixture() {
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState<GitChangeSourceId>("unstaged");
  const [identity, setIdentity] = useState<string>();
  const [findQuery, setFindQuery] = useState("");
  const refresh = () => setRevision((value) => value + 1);
  const liveState = useGitRepository({
    workspacePath: root,
    workspaceIdentity: identity,
    remoteSessionId: identity ? "fixture-remote" : undefined,
    includeExtendedData: true,
    enabled: live,
    refreshToken: revision,
  });
  useGitAutoRefresh({
    workspacePath: root,
    workspaceIdentity: identity,
    remoteSessionId: identity ? "fixture-remote" : undefined,
    gitSummary: liveState.summary,
    gitSummaryWorkspaceKey: liveState.workspaceKey,
    enabled: live,
    livePanelVisible: live,
    onRefreshGit: refresh,
  });
  Object.assign(globalThis, {
    __gitFiles: {
      calls,
      hold: () => {
        hold = true;
      },
      release: () => {
        hold = false;
        release?.();
      },
      fail: () => {
        fail = true;
      },
      busy: () => {
        busy = true;
      },
      external: () => {
        version++;
      },
      remote: () => setIdentity("fixture:remote"),
      disconnect: () =>
        useRemoteWorkspaceSessionStore.getState().unregisterSession("fixture-remote"),
      source: setSource,
      search: setFindQuery,
      loading: () => setLoading(true),
      loaded: () => setLoading(false),
      refresh,
      ...refreshProbe.controls,
      metrics: () => ({
        ...refreshProbe.metrics(),
        revision: liveState.revision,
        loading: liveState.loading,
      }),
    },
  });
  const state = {
    workspaceKey: identity || root,
    revision,
    loading,
    error: null,
    summary: {
      workspacePath: root,
      repoRoot: root,
      workspaceInRepoPath: ".",
      autoRefreshWatchPaths: [],
      branchName: "main",
      trackingBranchName: null,
      headRefType: "branch",
      ahead: 0,
      behind: 0,
      isDirty: true,
      isGitAvailable: true,
      isRepository: true,
    },
    sourceOptions: ["unstaged", "staged", "branch", "last-turn"].map((id) => ({
      id,
      count: 1,
      readonly: id === "branch" || id === "last-turn",
      disabled: false,
    })),
    datasets: Object.fromEntries(
      ["unstaged", "staged", "branch", "last-turn"].map((id) => [
        id,
        {
          id,
          readonly: id === "branch" || id === "last-turn",
          sections: [{ id, changes: id === "staged" ? staged : unstaged }],
        },
      ]),
    ),
  } as GitPaneRepositoryState;
  return (
    <main className="h-dvh max-w-xl border-r border-border">
      {new URLSearchParams(location.search).has("branch") ? (
        <BranchProbe root={root} identity={identity} refresh={refresh} />
      ) : null}
      <output data-testid="refresh-count" className="sr-only">
        {revision}
      </output>
      <GitPane
        workspacePath={root}
        workspaceIdentity={identity}
        workspaceRemoteSessionId={identity ? "fixture-remote" : undefined}
        gitState={live ? liveState : state}
        selectedSourceId={source}
        onSelectSource={setSource}
        onRefresh={refresh}
        onClose={() => {}}
        fileChangeFindActiveIndex={0}
        fileChangeFindNavigationRequestId={0}
        fileChangeFindQuery={findQuery}
        onFileChangeFindMatchCountChange={() => {}}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={local}>
    <PlatformProvider platform={platform}>
      <LCodeIntlProvider
        initialLocale={new URLSearchParams(location.search).has("english") ? "en-US" : "zh-CN"}
      >
        <TooltipProvider>
          <TabStoreProvider>
            <StoreProvider broadcastService={broadcast}>
              <DiffsWorkerPoolProvider>
                <Fixture />
              </DiffsWorkerPoolProvider>
            </StoreProvider>
          </TabStoreProvider>
        </TooltipProvider>
      </LCodeIntlProvider>
    </PlatformProvider>
  </ServiceProvider>,
);
