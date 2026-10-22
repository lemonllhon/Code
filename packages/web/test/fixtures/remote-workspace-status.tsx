import { useState } from "react";
import { createRoot } from "react-dom/client";
import { buildRemoteWorkspaceIdentity, type RemoteTarget, type LCodeTaskMeta } from "@lcode/shared";
import type {
  IServiceAccessor,
  WindowHostControllerFrame,
  WindowHostControllerTaskListItem,
} from "@lcode/services";
import { CONTROLLER_TASKS_INDEX_TOPIC } from "@lcode/shared/lcode-protocol-v4";
import { WorkspaceSidebarItem } from "@/WorkspaceSidebarItem.js";
import { WorkspaceTimelineTasksSection } from "@/WorkspaceTimelineTasksSection.js";
import { WorkspacePinnedTasksSection } from "@/WorkspacePinnedTasksSection.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useRemoteTimelineTaskStore } from "@/store/remoteTimelineTaskStore.js";
import { useRemotePinnedTaskStore } from "@/store/remotePinnedTaskStore.js";
import { buildWorkspaceSessionKey } from "@/lib/remoteWorkspaceHistory.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { services as defaults } from "./sidebar-file-tree-service.js";
import { platform } from "./git-backup-platform.js";
import "@/styles.css";

const noop = () => {};
const subscribe = () => ({ dispose: noop });
const path = "/fixture/same-path";
const params = new URLSearchParams(location.search);
const targets: RemoteTarget[] = [
  { kind: "ssh", host: "example.invalid", username: "fixture", port: 22 },
  { kind: "wsl", distro: "Fixture" },
  { kind: "docker", container: "fixture-container" },
];
const tabs: WorkspaceTabState[] = [
  { id: "local", kind: "workspace", label: "local", workspacePath: path },
  ...targets.map((remoteTarget) => ({
    id: remoteTarget.kind,
    kind: "workspace" as const,
    label: remoteTarget.kind,
    workspacePath: path,
    workspaceIdentity: buildRemoteWorkspaceIdentity(path, remoteTarget),
    remoteSessionId: remoteTarget.kind,
    remoteTarget,
  })),
];
const listeners = new Set<(frame: WindowHostControllerFrame) => void>();
const queries: unknown[] = [];
const pendingQueries = new Map<number, { resolve(): void; reject(error: Error): void }>();
let querySerial = 0;
let seq = 0;
const now = Date.now();
const items: (WindowHostControllerTaskListItem & { pinnedAt?: number })[] = tabs.flatMap((tab) =>
  [false, true].map((pinned) => ({
    taskId: pinned ? "pinned" : "same-task",
    traceId: "fixture-trace" as never,
    title: `${tab.id}${pinned ? " pinned" : " task"}`,
    mode: "build" as const,
    createdAt: now - 60000,
    updatedAt: now,
    workspacePath: path,
    workspaceIdentity: tab.workspaceIdentity,
    remoteSessionId: tab.remoteSessionId,
    pinnedAt: pinned ? 1 : undefined,
    status: "running" as const,
    sourceAvailability: "online" as const,
    liveStatus: "running" as const,
    activity: { phase: "running" as const, lastActivityAt: now, hasBackgroundWork: false },
  })),
);
const services = {
  ...defaults,
  windowControllerService: {
    ...defaults.windowControllerService,
    onDynamicControllerFrame: () => (listener: (frame: WindowHostControllerFrame) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    subscribeControllerV4: async ({ topic }: { topic: string }) => ({
      ack: { subscriptionId: topic, mode: "snapshot" as const, logEpoch: "fixture" },
    }),
    listTaskList: async (query: {
      kind: string;
      workspaceScopes: { workspacePath: string; workspaceIdentity?: string }[];
    }) => {
      queries.push(query);
      const selected = (params.has("empty") ? [] : items).filter(
        (item) =>
          query.workspaceScopes.some(
            (scope) =>
              (scope.workspaceIdentity || scope.workspacePath) ===
              (item.workspaceIdentity || item.workspacePath),
          ) && (query.kind === "pinned" ? item.pinnedAt : !item.pinnedAt),
      );
      const result = { items: structuredClone(selected), total: selected.length, hasMore: false };
      if (params.has("hold-queries")) {
        await new Promise<void>((resolve, reject) => {
          pendingQueries.set(++querySerial, { resolve, reject });
        });
      }
      return result;
    },
  },
} as IServiceAccessor;
const registry = useRemoteWorkspaceSessionStore.getState();
registry.registerBaseServices(services);
function connect(tab: WorkspaceTabState) {
  registry.registerSession({
    sessionId: tab.remoteSessionId!,
    workspacePath: path,
    workspaceIdentity: tab.workspaceIdentity,
    target: tab.remoteTarget!,
    services,
  });
  registry.bindWorkspaceIdentity(tab.workspaceIdentity!, tab.remoteSessionId!);
}
tabs.slice(1).forEach(connect);
// 旧缓存故意提供过期历史行：生产列表必须使用 Controller，不能把它当实时执行依据。
for (const item of items.filter((item) => item.workspaceIdentity)) {
  const stale: LCodeTaskMeta = { ...item, status: "completed", title: item.title };
  if (item.pinnedAt) useRemotePinnedTaskStore.getState().upsertTask(stale);
  else useRemoteTimelineTaskStore.getState().upsertTask(stale);
}
function notify() {
  const frame = {
    topic: CONTROLLER_TASKS_INDEX_TOPIC,
    subscriptionId: CONTROLLER_TASKS_INDEX_TOPIC,
    logEpoch: "fixture",
    fromSeq: seq,
    toSeq: ++seq,
    payload: { kind: "snapshot", snapshot: { protocolVersion: 1, logEpoch: "fixture", tasks: [] } },
  } as unknown as WindowHostControllerFrame;
  listeners.forEach((listener) => listener(frame));
}
Object.assign(globalThis, {
  __remoteStatus: {
    queries,
    pendingQueries: () => [...pendingQueries.keys()],
    settleQueries: (ids = [...pendingQueries.keys()], error?: string) => {
      for (const id of ids) {
        const pending = pendingQueries.get(id);
        pendingQueries.delete(id);
        if (error) pending?.reject(new Error(error));
        else pending?.resolve();
      }
    },
    replaceController: () =>
      registry.registerBaseServices({
        ...services,
        windowControllerService: { ...services.windowControllerService! },
      }),
    setActivity: (
      kind: string,
      phase: NonNullable<WindowHostControllerTaskListItem["activity"]>["phase"],
      background = false,
      waiting = false,
    ) => {
      for (const item of items.filter((item) => item.remoteSessionId === kind)) {
        item.activity = {
          phase,
          lastActivityAt: now + ++seq,
          hasBackgroundWork: background,
          ...(waiting ? { pendingInteractions: { permissionCount: 1, userInputCount: 0 } } : {}),
        };
        item.status = phase === "error" ? "error" : phase === "running" ? "running" : "completed";
        item.unreadAt = phase === "completedSuccess" ? now + seq : undefined;
      }
      notify();
    },
    setOffline: (kind: string, offline: boolean) => {
      for (const item of items.filter((item) => item.remoteSessionId === kind))
        item.sourceAvailability = offline ? "offline" : "online";
      notify();
    },
  },
});

function Fixture() {
  const [connection, setConnection] = useState("connected");
  const [selected, setSelected] = useState(tabs[1]!);
  const [expanded, setExpanded] = useState(true);
  const [queryTabs, setQueryTabs] = useState(tabs);
  const [sortBy, setSortBy] = useState<"updated" | "created">("updated");
  const key = buildWorkspaceSessionKey(selected);
  const {
    items: tasks,
    loading,
    syncingRemoteWorkspaces,
  } = useGlobalTaskList({
    kind: "timeline",
    workspaceTabs: queryTabs,
    sortBy,
    searchQuery: "",
    expanded: true,
    collapsedLimit: 20,
  });
  return (
    <main className="max-w-md bg-sidebar p-2 text-ui-base text-foreground">
      <output
        data-testid="task-query-state"
        data-loading={loading}
        data-syncing-remote={syncingRemoteWorkspaces}
        data-count={tasks.length}
      />
      {params.has("hold-queries") ? (
        <>
          <button data-testid="change-query" onClick={() => setSortBy("created")}>
            Change query
          </button>
          <button
            data-testid="replace-session"
            onClick={() => {
              const next = queryTabs.map((tab) =>
                tab.remoteSessionId
                  ? { ...tab, remoteSessionId: `${tab.remoteSessionId}-next` }
                  : tab,
              );
              next.slice(1).forEach(connect);
              setQueryTabs(next);
              setSelected(next.find((tab) => tab.id === selected.id)!);
            }}
          >
            Replace session
          </button>
        </>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {tabs.slice(1).map((tab) => (
          <button
            key={tab.id}
            data-testid={`kind-${tab.id}`}
            onClick={() => {
              setSelected(tab);
              setConnection("connected");
              connect(tab);
            }}
          >
            {tab.id}
          </button>
        ))}
        {["connected", "connecting", "failed", "idle"].map((value) => (
          <button
            key={value}
            data-testid={`connection-${value}`}
            onClick={() => {
              if (value === "connected") connect(selected);
              else registry.unregisterSession(selected.remoteSessionId!);
              setConnection(value);
            }}
          >
            {value}
          </button>
        ))}
      </div>
      <ul data-testid="project-status">
        <WorkspaceSidebarItem
          tab={selected}
          isActiveWorkspace
          isExpanded={expanded}
          activateTab={noop}
          closeTab={noop}
          toggleWorkspaceExpanded={() => setExpanded(!expanded)}
          onSelectTask={noop}
          onStartDraftInWorkspace={noop}
          taskItems={tasks.filter((task) => task.workspaceIdentity === selected.workspaceIdentity)}
          taskListLoading={false}
          taskListHasMore={false}
          onShowMoreTasks={noop}
          reconnectingRemoteWorkspaceKeys={connection === "connecting" ? [key] : []}
          remoteWorkspaceErrorByWorkspaceKey={
            connection === "failed" ? { [key]: "Fixture connection failed" } : {}
          }
          reconnectingRemoteWorkspaceLogsByWorkspaceKey={{
            [key]: [
              {
                id: "deploy",
                level: "info",
                timestamp: "12:00:00",
                message: "Fixture deploying runtime 50%",
              },
            ],
          }}
          onReconnectRemoteWorkspace={async () => setConnection("connecting")}
        />
      </ul>
      <div data-testid="timeline-status">
        <WorkspaceTimelineTasksSection
          workspaceTabs={queryTabs}
          activeWorkspacePath={path}
          activeTaskId={null}
          taskSortBy={sortBy}
          onSelectTask={noop}
        />
      </div>
      <div data-testid="pinned-status">
        <WorkspacePinnedTasksSection
          workspaceTabs={queryTabs}
          activeWorkspacePath={path}
          activeTaskId={null}
          taskSortBy={sortBy}
          onSelectTask={noop}
        />
      </div>
    </main>
  );
}
const theme = params.get("theme") || "zai-dark";
document.documentElement.classList.toggle("dark", theme === "zai-dark");
document.documentElement.classList.add(`theme-${theme}`);
createRoot(document.getElementById("root")!).render(
  <PlatformProvider platform={platform}>
    <ServiceProvider services={services}>
      <StoreProvider broadcastService={{ onMessage: subscribe, send: async () => {} } as never}>
        <TabStoreProvider>
          <LCodeIntlProvider initialLocale={params.has("english") ? "en-US" : "zh-CN"}>
            <TooltipProvider>
              <Fixture />
            </TooltipProvider>
          </LCodeIntlProvider>
        </TabStoreProvider>
      </StoreProvider>
    </ServiceProvider>
  </PlatformProvider>,
);
