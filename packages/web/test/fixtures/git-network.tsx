import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IBroadcastService, IGitService, IServiceAccessor } from "@lcode/services";
import type { GitFastForwardPreview, GitNetworkOperation, GitNetworkSnapshot } from "@lcode/shared";
import { GitReviewSidePane } from "@/app-shell/GitReviewSidePane.js";
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

const root = "/fixture/repo";
let reason: GitFastForwardPreview["reason"] = "ready";
let hold = false,
  partial = false,
  fail = false;
let lostAck = false;
let release: (() => void) | null = null;
const calls: { host: string; method: string; params: unknown }[] = [];
const service = (host: string) => {
  let version = 1;
  let snapshot: GitNetworkSnapshot = {
    revision: String(version).padStart(64, "0"),
    branch: "main",
    head: "a".repeat(40),
    upstream: "origin/main",
    ahead: 0,
    behind: 2,
    remotes: [
      {
        name: "origin",
        fetchUrls: ["https://example.invalid/team/repository-with-a-long-name.git"],
        pushUrls: ["ssh://git@example.invalid/team/repository.git"],
      },
      { name: "backup", fetchUrls: ["https://example.invalid/backup.git"], pushUrls: [] },
    ],
    branches: [{ name: "main", head: "a".repeat(40), upstream: "origin/main" }],
    remoteBranches: [{ remote: "origin", branch: "main", head: "b".repeat(40) }],
  };
  const receipts = new Map<string, GitNetworkOperation>();
  const preview = (): GitFastForwardPreview => ({
    revision: snapshot.revision,
    state: {
      headCommitHash: snapshot.head,
      branchName: "main",
      indexFingerprint: "c".repeat(64),
      worktreeFingerprint: "d".repeat(64),
    },
    branch: "main",
    head: snapshot.head,
    upstream: snapshot.upstream,
    target: "b".repeat(40),
    reason,
  });
  const wait = async () => {
    if (hold)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
  };
  return {
    getNetworkSnapshot: async (params: unknown) => {
      calls.push({ host, method: "snapshot", params });
      return structuredClone(snapshot);
    },
    getNetworkOperation: async (params: { requestId: string }) => {
      calls.push({ host, method: "receipt", params });
      return receipts.get(params.requestId) ?? null;
    },
    previewFastForward: async (params: unknown) => {
      calls.push({ host, method: "preview", params });
      await wait();
      return preview();
    },
    ...Object.fromEntries(
      ["mutateRemote", "setBranchTracking", "fetchRemotes", "fastForward"].map((method) => [
        method,
        async (params: {
          requestId: string;
          expectedRevision: string;
          action: string;
          name: string;
          newName: string;
          fetchUrls: string[];
          pushUrls: string[];
          upstream: { remote: string; branch: string } | null;
          remotes: string[];
        }) => {
          calls.push({ host, method, params });
          await wait();
          const receipt: GitNetworkOperation = {
            requestId: params.requestId,
            kind:
              method === "mutateRemote"
                ? "remote"
                : method === "setBranchTracking"
                  ? "tracking"
                  : method === "fetchRemotes"
                    ? "fetch"
                    : "fast-forward",
            status: fail
              ? "failed"
              : params.expectedRevision !== snapshot.revision
                ? "failed"
                : "success",
            startedAt: "2026-10-20T01:00:00.000Z",
            finishedAt: "2026-10-20T01:00:01.000Z",
          };
          if (params.expectedRevision !== snapshot.revision) receipt.code = "stale-preview";
          else if (!fail) {
            if (method === "mutateRemote") {
              if (params.action === "add")
                snapshot.remotes.push({
                  name: params.name,
                  fetchUrls: params.fetchUrls,
                  pushUrls: params.pushUrls,
                });
              if (params.action === "edit")
                snapshot.remotes = snapshot.remotes.map((remote) =>
                  remote.name === params.name
                    ? { ...remote, fetchUrls: params.fetchUrls, pushUrls: params.pushUrls }
                    : remote,
                );
              if (params.action === "remove")
                snapshot.remotes = snapshot.remotes.filter((remote) => remote.name !== params.name);
              if (params.action === "rename")
                snapshot.remotes = snapshot.remotes.map((remote) =>
                  remote.name === params.name ? { ...remote, name: params.newName } : remote,
                );
            }
            if (method === "setBranchTracking")
              snapshot.upstream = params.upstream
                ? `${params.upstream.remote}/${params.upstream.branch}`
                : null;
            if (method === "fetchRemotes") {
              receipt.results = params.remotes.map((remote) => ({
                remote,
                status: partial && remote === "backup" ? "failed" : "success",
              }));
              receipt.status = partial ? "partial" : "success";
            }
            if (method === "fastForward") {
              snapshot.head = "b".repeat(40);
              snapshot.behind = 0;
            }
            version++;
            snapshot = { ...snapshot, revision: String(version).padStart(64, "0") };
          }
          receipts.set(params.requestId, receipt);
          if (lostAck) {
            lostAck = false;
            throw new Error("fixture-lost-ack");
          }
          return receipt;
        },
      ]),
    ),
  } as unknown as IGitService;
};
const local = { gitService: service("local") } as IServiceAccessor;
const remote = { gitService: service("remote") } as IServiceAccessor;
const registry = useRemoteWorkspaceSessionStore.getState();
registry.registerBaseServices(local);
registry.registerSession({ sessionId: "fixture-remote", services: remote });
registry.bindWorkspaceIdentity("fixture:remote", "fixture-remote");
const broadcast = {
  send: async () => {},
  onMessage: () => ({ dispose() {} }),
} as IBroadcastService;
function Fixture() {
  const setTheme = useLCodeStore((state) => state.setTheme);
  useEffect(() => {
    setTheme("zai-light");
  }, [setTheme]);
  const [identity, setIdentity] = useState<string>();
  const [view, setView] = useState<GitWorkbenchView>("changes");
  const [refreshCount, setRefreshCount] = useState(0);
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
    __gitNetwork: {
      theme: setTheme,
      lostAck: () => {
        lostAck = true;
      },
      calls,
      hold: () => {
        hold = true;
      },
      release: () => {
        hold = false;
        release?.();
      },
      partial: () => {
        partial = true;
      },
      reason: (value: typeof reason) => {
        reason = value;
      },
      remote: () => setIdentity("fixture:remote"),
      disconnect: () => registry.unregisterSession("fixture-remote"),
    },
  });
  return (
    <main className="h-dvh max-w-lg border-r border-border">
      <GitReviewSidePane
        onRefresh={() => setRefreshCount((count) => count + 1)}
        workspaceKey={identity || root}
        sessionId="fixture-session"
        workspacePath={root}
        workspaceIdentity={identity}
        workspaceRemoteSessionId={identity ? "fixture-remote" : undefined}
        view={view}
        visible
      >
        <p>Changes fixture</p>
      </GitReviewSidePane>
      <output className="sr-only" data-testid="network-refresh-count">
        {refreshCount}
      </output>
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
              <Fixture />
            </StoreProvider>
          </TabStoreProvider>
        </TooltipProvider>
      </LCodeIntlProvider>
    </PlatformProvider>
  </ServiceProvider>,
);
