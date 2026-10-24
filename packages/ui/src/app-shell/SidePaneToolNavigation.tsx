import {
  FileIcon,
  GitBranchIcon,
  GlobeIcon,
  MoreHorizontalIcon,
  SquareTerminalIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkspaceSidePaneTab } from "@/lib/workspaceSidePane.js";
import { useEffect, useRef, type DragEventHandler } from "react";

function sidePaneTool(tab: WorkspaceSidePaneTab): string {
  if (tab.type === "git") return "git";
  if (tab.type === "code-viewer") return "files";
  if (tab.type === "browser" || tab.type === "browser-use") return "browser";
  if (tab.type === "terminal") return "terminal";
  return "more";
}

const tools = [
  { id: "git", icon: GitBranchIcon, label: "Git" },
  { id: "files", icon: FileIcon, label: "sidePane.files" },
  { id: "browser", icon: GlobeIcon, label: "browser.title" },
  { id: "terminal", icon: SquareTerminalIcon, label: "terminal.title" },
  { id: "more", icon: MoreHorizontalIcon, label: "sidePane.more" },
] as const;

export function SidePaneToolNavigation({
  tabs,
  activeTabId,
  onActivate,
  onToolDragEnd,
}: {
  tabs: readonly WorkspaceSidePaneTab[];
  activeTabId: string;
  onActivate: (id: string) => void;
  onToolDragEnd?: (id: string, event: Parameters<DragEventHandler>[0]) => void;
}) {
  const { intl } = useLCodeIntl();
  const active = tabs.find((tab) => tab.id === activeTabId);
  const dragCancelled = useRef(false);
  const stopWatchingDrag = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => stopWatchingDrag.current?.(), []);
  return (
    <nav
      className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1"
      aria-label={intl.formatMessage({ id: "sidePane.tools" })}
    >
      {tools.map(({ id, label, icon: Icon }) => {
        const target =
          active && sidePaneTool(active) === id
            ? active
            : tabs.findLast((tab) => sidePaneTool(tab) === id);
        if (!target) return null;
        const selected = active && sidePaneTool(active) === id;
        const text = id === "git" ? label : intl.formatMessage({ id: label });
        return (
          <Button
            key={id}
            type="button"
            variant="ghost"
            size="sm"
            className={
              selected
                ? "h-7 shrink-0 rounded-sm bg-selected text-ui-sm"
                : "h-7 shrink-0 rounded-sm text-ui-sm text-foreground-subtle"
            }
            aria-current={selected ? "page" : undefined}
            aria-label={text}
            title={text}
            data-testid={`side-pane-tool-${id}`}
            draggable={Boolean(onToolDragEnd)}
            onDragStart={
              onToolDragEnd
                ? (event) => {
                    dragCancelled.current = false;
                    const owner = event.currentTarget.ownerDocument;
                    const cancel = (event: KeyboardEvent) => {
                      if (event.key === "Escape") dragCancelled.current = true;
                    };
                    stopWatchingDrag.current?.();
                    owner.addEventListener("keydown", cancel, true);
                    stopWatchingDrag.current = () =>
                      owner.removeEventListener("keydown", cancel, true);
                    event.dataTransfer.setData("text/plain", text);
                    event.dataTransfer.effectAllowed = "move";
                  }
                : undefined
            }
            onDragEnd={
              onToolDragEnd
                ? (event) => {
                    stopWatchingDrag.current?.();
                    if (!dragCancelled.current) onToolDragEnd(target.id, event);
                  }
                : undefined
            }
            onClick={() => {
              onActivate(target.id);
            }}
          >
            <Icon className="size-4 shrink-0" />
            <span className="hidden @min-[600px]/side-pane-tools:inline">{text}</span>
          </Button>
        );
      })}
    </nav>
  );
}
