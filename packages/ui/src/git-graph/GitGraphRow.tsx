import { useState, type CSSProperties, type KeyboardEvent } from "react";
import { GitMergeIcon, MoreHorizontal } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { formatCommitTime, getRefIcon, getShortHash } from "./GitGraphDisplay.js";
import type { GitGraphCommit } from "./layout.js";
export type CommitAction = "view" | "cherry-pick" | "revert" | "tag" | "reset";
export const responsiveColumns =
  "grid-cols-[minmax(0,1fr)] @min-[620px]/gitgraph:grid-cols-[minmax(0,1fr)_var(--git-date-width)_var(--git-author-width)_var(--git-commit-width)]";
export const wideColumns = {
  gridTemplateColumns:
    "minmax(260px,1fr) var(--git-date-width) var(--git-author-width) var(--git-commit-width)",
};
export function GitGraphRow({
  commit,
  selected,
  compact,
  disabled,
  height,
  testId,
  tabIndex,
  elementRef,
  onSelect,
  onNavigate,
  onHover,
  onAction,
  checked,
  onToggle,
}: {
  checked?: boolean;
  onToggle?: () => void;
  commit: GitGraphCommit;
  selected: boolean;
  compact: boolean;
  disabled: boolean;
  height: number;
  testId?: string;
  tabIndex: number;
  elementRef: (el: HTMLButtonElement | null) => void;
  onSelect: () => void;
  onNavigate: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onHover: (hash: string | null) => void;
  onAction?: (hash: string, action: CommitAction) => void;
}) {
  const { intl, locale } = useLCodeIntl();
  const [menuOpen, setMenuOpen] = useState(false);
  const time = formatCommitTime(commit.authoredAtMs, locale);
  // 共享图谱的旧入口允许缺少作者/时间；提示保留未知值，不能把 null 渲染成 1970 年。
  const fullTime =
    commit.authoredAtMs == null ? undefined : new Date(commit.authoredAtMs).toLocaleString(locale);
  const meta = compact ? "hidden @min-[620px]/gitgraph:block" : "";
  const refs = commit.refs.slice(0, compact ? 2 : 4);
  const items = (context: boolean) => {
    const Item = context ? ContextMenuItem : DropdownMenuItem;
    return (["view", "cherry-pick", "revert", "tag", "reset"] as const).map((action) => (
      <Item
        key={action}
        disabled={
          disabled ||
          (commit.parents.length > 1 && (action === "cherry-pick" || action === "revert"))
        }
        onSelect={() => onAction?.(commit.hash, action)}
      >
        {action === "view" || action === "tag"
          ? intl.formatMessage({ id: `git.history.${action === "view" ? "viewCommit" : "tag"}` })
          : action === "reset"
            ? "Reset…"
            : action === "revert"
              ? "Revert"
              : "Cherry-pick"}
      </Item>
    ));
  };
  const row = (
    <div
      className={cn("group relative min-w-0", selected && "bg-selected")}
      style={{ height }}
      onMouseEnter={() => onHover(commit.hash)}
      onMouseLeave={() => onHover(null)}
    >
      {onToggle ? (
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={onToggle}
          aria-label={intl.formatMessage(
            { id: "git.history.selectCommit" },
            { hash: getShortHash(commit.hash) },
          )}
          className="absolute left-1 z-1 size-3.5"
          style={{ top: height / 2 - 7 }}
        />
      ) : null}
      <button
        ref={elementRef}
        type="button"
        aria-disabled={disabled}
        aria-pressed={selected}
        tabIndex={tabIndex}
        data-testid={testId}
        data-commit-hash={commit.hash}
        title={`${commit.subject}\n${commit.hash}`}
        className={cn(
          "grid h-full w-full min-w-0 items-center text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-input-border-focused",
          selected && "bg-selected",
          compact && responsiveColumns,
        )}
        style={compact ? undefined : (wideColumns as CSSProperties)}
        onClick={() => {
          if (!disabled) onSelect();
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          if (
            onAction &&
            (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
          ) {
            event.preventDefault();
            event.stopPropagation();
            // 键盘入口直接交给受控菜单；合成 click 不携带 Radix 的 pointerdown，无法可靠打开菜单。
            setMenuOpen(true);
          } else onNavigate(event);
        }}
      >
        <span className={cn("min-w-0 px-2 pr-8", onToggle && "pl-6")}>
          <span className="flex min-w-0 items-center gap-1.5">
            {refs.length ? (
              <span
                className="flex min-w-0 max-w-[45%] shrink-0 items-center gap-1 overflow-hidden"
                title={commit.refs.map((ref) => ref.name).join(", ")}
              >
                {refs.map((ref) => (
                  <span
                    key={`${ref.kind}:${ref.name}`}
                    className={cn(
                      "inline-flex h-4 min-w-0 items-center gap-0.5 rounded-sm border border-border bg-surface px-1 text-ui-xs text-foreground-subtle",
                      ref.kind === "head" && "border-git-descendant text-foreground",
                      ref.kind === "tag" && "border-git-added",
                    )}
                  >
                    {getRefIcon(ref, "size-2.5 shrink-0")}
                    <span className="max-w-20 truncate">{ref.name}</span>
                  </span>
                ))}
                {commit.refs.length > refs.length ? (
                  <span className="text-ui-xs">+{commit.refs.length - refs.length}</span>
                ) : null}
              </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate text-ui-sm">
              {commit.subject || getShortHash(commit.hash)}
            </span>
            {commit.parents.length > 1 ? (
              <GitMergeIcon className="size-3 shrink-0 text-git-renamed" />
            ) : null}
          </span>
          {compact ? (
            <span className="block truncate text-ui-xs text-foreground-subtle @min-[620px]/gitgraph:hidden">
              {getShortHash(commit.hash)} · {commit.authorName} · {time}
            </span>
          ) : null}
        </span>
        <span
          className={cn("truncate px-2 text-ui-sm text-foreground-subtle", meta)}
          title={fullTime}
        >
          {time}
        </span>
        <span
          className={cn("truncate px-2 text-ui-sm text-foreground-subtle", meta)}
          title={commit.authorName ?? undefined}
        >
          {commit.authorName}
        </span>
        <span
          className={cn("truncate px-2 font-mono text-ui-xs text-foreground-subtle", meta)}
          title={commit.hash}
        >
          {getShortHash(commit.hash)}
        </span>
      </button>
      {onAction ? (
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={disabled}
              className="absolute right-0 size-7 @min-[620px]/gitgraph:opacity-0 @min-[620px]/gitgraph:group-hover:opacity-100 @min-[620px]/gitgraph:focus:opacity-100"
              style={{ top: height / 2 - 14 }}
              aria-label={intl.formatMessage(
                { id: "git.history.commitMenu" },
                { hash: getShortHash(commit.hash) },
              )}
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">{items(false)}</DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
  return onAction ? (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>{items(true)}</ContextMenuContent>
    </ContextMenu>
  ) : (
    row
  );
}
