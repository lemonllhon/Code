import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IPlatformService } from "@lcode/shared";
import type { IBroadcastService, IServiceAccessor } from "@lcode/services";
import { openDesktopToolWindow } from "../../../desktop/src/renderer/src/desktopToolWindow.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { SidePaneToolNavigation } from "@/app-shell/SidePaneToolNavigation.js";
import { SidePaneTabSurface } from "@/app-shell/SidePaneTabSurface.js";
import { useSidePaneToolWindows } from "@/hooks/useSidePaneToolWindows.js";
import { useBeforeToolWindowMove } from "@/hooks/useToolWindowMove.js";
import { SidePaneTerminalPane } from "@/SidePaneTerminalPane.js";
import { sidePaneTerminalSessionRegistry } from "@/terminal/sidePaneTerminalSessionRegistry.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import type { WorkspaceSidePaneTab } from "@/lib/workspaceSidePane.js";
import "@/styles.css";

const noop = () => {};
const facts = { mounts: 0, unmounts: 0, creates: 0, disposes: 0, writes: "", guardAllowed: true };
const output = new Set<(data: string) => void>();
const services = {
  terminalService: {
    create: async () => {
      facts.creates++;
      return { id: "retained-pty", shell: "bash", cwd: "/fixture" };
    },
    write: async ({ data }: { data: string }) => {
      facts.writes += data;
      for (const listener of output) listener(data);
    },
    resize: async () => {},
    dispose: async () => {
      facts.disposes++;
    },
    onDynamicData: () => (listener: (data: string) => void) => {
      output.add(listener);
      return { dispose: () => output.delete(listener) };
    },
    onDynamicExit: () => () => ({ dispose: noop }),
  },
} as unknown as IServiceAccessor;
const platform = { openToolWindow: openDesktopToolWindow } as IPlatformService;
const broadcast = { send: async () => {}, onMessage: () => noop } as IBroadcastService;
const allTabs = [
  { id: "git", type: "git" },
  { id: "terminal:fixture", type: "terminal", title: "Terminal" },
] as WorkspaceSidePaneTab[];

function Draft() {
  const [draft, setDraft] = useState("");
  useBeforeToolWindowMove(async () => facts.guardAllowed);
  useEffect(() => {
    facts.mounts++;
    return () => {
      facts.unmounts++;
    };
  }, []);
  return (
    <div className="p-3">
      <textarea
        aria-label="Commit draft"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <DropdownMenu>
        <DropdownMenuTrigger>Options</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Inside this window</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
function Fixture() {
  const [tabs, setTabs] = useState([allTabs[0]!]);
  const [active, setActive] = useState("git");
  const windows = useSidePaneToolWindows({
    enabled: true,
    onActivateTab: setActive,
    onCloseTab: (id) => {
      if (id.startsWith("terminal")) sidePaneTerminalSessionRegistry.release(id);
      setTabs((tabs) => tabs.filter((tab) => tab.id !== id));
    },
  });
  (window as unknown as { toolWindowFixture: unknown }).toolWindowFixture = {
    facts,
    detach: windows.detach,
    dock: windows.dock,
    setTabs,
    allTabs,
  };
  return (
    <main className="flex h-screen">
      <section className="flex-1">
        <button
          onClick={() => {
            setTabs(allTabs);
            setActive("terminal:fixture");
          }}
        >
          Add terminal
        </button>
        <button onClick={() => document.documentElement.classList.toggle("dark")}>Theme</button>
      </section>
      <section
        data-testid="dock"
        className="flex w-1/2 flex-col border-l border-border"
        {...windows.dropProps}
      >
        <SidePaneToolNavigation
          tabs={tabs.filter((tab) => !windows.isDetached(tab.id))}
          activeTabId={active}
          onActivate={setActive}
          onToolDragEnd={(id, event) => {
            if (event.clientX < innerWidth / 2 - 24) void windows.detach(id);
          }}
        />
        <button
          onClick={() => {
            void windows.detach(active);
          }}
        >
          Detach active
        </button>
        <div className="min-h-0 flex-1">
          {tabs.map((tab) => (
            <SidePaneTabSurface
              key={tab.id}
              id={tab.id}
              title={tab.id}
              selected={active === tab.id}
              windows={windows}
            >
              {tab.type === "terminal" ? (
                <SidePaneTerminalPane
                  sessionId={tab.id}
                  workspaceKey="fixture"
                  services={services}
                  isVisible={windows.isDetached(tab.id) || active === tab.id}
                  onOpenBrowserUrl={noop}
                />
              ) : (
                <Draft />
              )}
            </SidePaneTabSurface>
          ))}
        </div>
      </section>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <PlatformProvider platform={platform}>
    <ServiceProvider services={services}>
      <StoreProvider broadcastService={broadcast}>
        <LCodeIntlProvider initialLocale="zh-CN">
          <TooltipProvider>
            <Fixture />
          </TooltipProvider>
        </LCodeIntlProvider>
      </StoreProvider>
    </ServiceProvider>
  </PlatformProvider>,
);
