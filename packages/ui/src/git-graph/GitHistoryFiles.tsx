import { useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { historyTree, type HistoryTreeNode } from "./gitHistoryTree.js";
export function GitHistoryFiles({
  files,
  selected,
  disabled,
  onSelect,
}: {
  files: readonly { path: string; status: string }[];
  selected?: string;
  disabled: boolean;
  onSelect: (path: string) => void;
}) {
  const { intl } = useLCodeIntl();
  const roots = useMemo(() => historyTree(files), [files]);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [cursor, setCursor] = useState<string>();
  const elements = useRef(new Map<string, HTMLButtonElement>());
  const visible: { node: HistoryTreeNode; level: number; parent?: string }[] = [];
  const visit = (nodes: HistoryTreeNode[], level: number, parent?: string) =>
    nodes.forEach((node) => {
      visible.push({ node, level, parent });
      if (!collapsed.has(node.key)) visit(node.children, level + 1, node.key);
    });
  visit(roots, 1);
  const active = visible.some(({ node }) => node.key === cursor) ? cursor : visible[0]?.node.key;
  const toggle = (key: string) =>
    setCollapsed((old) => {
      const next = new Set(old);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <div role="tree" aria-label={intl.formatMessage({ id: "git.history.fileTree" })}>
      {visible.map(({ node, level, parent }, index) => {
        const directory = !node.status,
          expanded = !collapsed.has(node.key);
        const Icon = directory ? (expanded ? FolderOpen : Folder) : File;
        return (
          <button
            key={node.key}
            ref={(el) => {
              if (el) elements.current.set(node.key, el);
              else elements.current.delete(node.key);
            }}
            type="button"
            role="treeitem"
            aria-level={level}
            aria-expanded={directory ? expanded : undefined}
            aria-selected={!directory && selected === node.path}
            aria-disabled={disabled}
            tabIndex={active === node.key ? 0 : -1}
            data-testid={directory ? "git-history-directory" : "git-history-file"}
            title={node.path}
            className={cn(
              "flex h-7 w-full items-center gap-1.5 pr-2 text-left text-ui-sm outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-input-border-focused",
              selected === node.path && !directory && "bg-selected",
            )}
            style={{ paddingLeft: (level - 1) * 14 + 8 }}
            onFocus={() => setCursor(node.key)}
            onClick={() => {
              if (!disabled) {
                if (directory) toggle(node.key);
                else onSelect(node.path);
              }
            }}
            onKeyDown={(event) => {
              if (disabled) return;
              let target: string | undefined;
              if (event.key === "ArrowDown")
                target = visible[Math.min(index + 1, visible.length - 1)]?.node.key;
              if (event.key === "ArrowUp") target = visible[Math.max(0, index - 1)]?.node.key;
              if (event.key === "Home") target = visible[0]?.node.key;
              if (event.key === "End") target = visible.at(-1)?.node.key;
              if (event.key === "ArrowRight" && directory) {
                if (!expanded) toggle(node.key);
                else target = node.children[0]?.key;
              }
              if (event.key === "ArrowLeft") {
                if (directory && expanded) toggle(node.key);
                else target = parent;
              }
              if (
                ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(
                  event.key,
                )
              )
                event.preventDefault();
              if (target) {
                setCursor(target);
                elements.current.get(target)?.focus();
              }
            }}
          >
            {directory ? (
              expanded ? (
                <ChevronDown className="size-3 shrink-0" />
              ) : (
                <ChevronRight className="size-3 shrink-0" />
              )
            ) : (
              <span className="w-3 shrink-0" />
            )}
            <Icon className="size-3.5 shrink-0 text-foreground-subtle" />
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
            <span
              className={cn(
                "shrink-0 font-mono text-ui-xs",
                node.status === "A"
                  ? "text-git-added"
                  : node.status === "D"
                    ? "text-git-deleted"
                    : "text-foreground-subtle",
              )}
            >
              {directory ? node.count : node.status}
            </span>
          </button>
        );
      })}
    </div>
  );
}
