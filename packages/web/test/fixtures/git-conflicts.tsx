import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IBroadcastService, IServiceAccessor } from "@lcode/services";
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
import { calls, controls, conflictService } from "./git-conflict-service.js";
import "@lcode/ui/styles.css";
const query = new URLSearchParams(location.search),
  root = "/fixture/repo";
const first = conflictService(
    "local",
    query.has("external"),
    query.has("binary"),
    query.has("mixed"),
  ),
  second = conflictService("remote", false, query.has("binary"), query.has("mixed"));
const local = { gitService: first.service } as IServiceAccessor,
  remote = { gitService: second.service } as IServiceAccessor;
const registry = useRemoteWorkspaceSessionStore.getState();
registry.registerBaseServices(local);
registry.registerSession({ sessionId: "fixture-remote", services: remote });
registry.bindWorkspaceIdentity("fixture:remote", "fixture-remote");
const broadcast = {
  send: async () => {},
  onMessage: () => ({ dispose() {} }),
} as IBroadcastService;
function Fixture() {
  const theme = useLCodeStore((state) => state.setTheme);
  useEffect(() => {
    theme(query.has("dark") ? "zai-dark" : "zai-light");
  }, [theme]);
  const [identity, setIdentity] = useState<string>(),
    [view, setView] = useState<GitWorkbenchView>("changes");
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
    __gitConflicts: {
      calls,
      ...controls,
      externalChange: first.externalChange,
      remote: () => setIdentity("fixture:remote"),
      disconnect: () => registry.unregisterSession("fixture-remote"),
    },
  });
  return (
    <main
      className={`h-dvh min-w-0 border-r border-border ${query.has("wide") ? "w-full" : "max-w-lg"}`}
    >
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
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={local}>
    <PlatformProvider platform={platform}>
      <LCodeIntlProvider initialLocale={query.has("english") ? "en-US" : "zh-CN"}>
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
