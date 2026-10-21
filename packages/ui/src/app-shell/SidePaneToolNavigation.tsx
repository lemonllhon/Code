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

export function sidePaneTool(tab: WorkspaceSidePaneTab): string {
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
  onOpenGit,
}: {
  tabs: readonly WorkspaceSidePaneTab[];
  activeTabId: string;
  onActivate: (id: string) => void;
  onOpenGit?: () => void;
}) {
  const { intl } = useLCodeIntl();
  const active = tabs.find((tab) => tab.id === activeTabId);
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
            title={
              target || (id === "git" && onOpenGit)
                ? text
                : intl.formatMessage({ id: "sidePane.noToolResources" }, { tool: text })
            }
            disabled={!target && !(id === "git" && onOpenGit)}
            data-testid={`side-pane-tool-${id}`}
            onClick={() => {
              if (target) onActivate(target.id);
              else if (id === "git") onOpenGit?.();
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
