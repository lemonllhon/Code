import { useMemo, useState } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  ListCollapseIcon,
  ListTreeIcon,
} from "lucide-react";
import type { ReviewPreviewFile } from "@/lib/codeViewer.js";
import type { ReviewFileActions } from "@/store/reviewDiffNavigationStore.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { cn } from "@/components/lib/utils.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildReviewFileTree,
  reviewTreeCheckState,
  reviewTreePaths,
  type ReviewFileTreeNode,
} from "./reviewFileTreeModel.js";

export function ReviewFileTree({
  files,
  untrackedPaths,
  selected,
  excluded,
  actions,
  onSelect,
}: {
  files: readonly ReviewPreviewFile[];
  untrackedPaths?: ReadonlySet<string>;
  selected?: ReviewPreviewFile;
  excluded: ReadonlySet<string>;
  actions?: ReviewFileActions;
  onSelect: (file: ReviewPreviewFile) => void;
}) {
  const { intl } = useLCodeIntl();
  const nodes = useMemo(() => buildReviewFileTree(files, untrackedPaths), [files, untrackedPaths]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const text = (id: string) => intl.formatMessage({ id: `git.review.${id}` });
  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const render = (node: ReviewFileTreeNode, depth = 0): React.ReactNode => {
    const file = node.file;
    const open = !collapsed.has(node.id);
    const paths = reviewTreePaths(node);
    const label =
      node.kind === "changes" || node.kind === "untracked"
        ? text(node.kind === "changes" ? "trackedChanges" : "unversioned")
        : node.label;
    const Folder = open ? FolderOpenIcon : FolderIcon;
    return (
      <li key={node.id} data-review-file={file ? "true" : undefined}>
        <div
          className={cn(
            "group flex h-7 min-w-0 items-center gap-1 pr-2 text-ui-base hover:bg-hover",
            file === selected && "bg-selected",
          )}
          style={{ paddingLeft: 4 + depth * 14 }}
        >
          {file ? (
            <span className="w-4 shrink-0" />
          ) : (
            <button
              type="button"
              className="flex size-4 shrink-0 items-center justify-center text-foreground-subtle focus-visible:ring-2 focus-visible:ring-input-border-focused"
              aria-label={label}
              aria-expanded={open}
              onClick={() => toggle(node.id)}
            >
              {open ? (
                <ChevronDownIcon className="size-3.5" />
              ) : (
                <ChevronRightIcon className="size-3.5" />
              )}
            </button>
          )}
          {actions ? (
            <Checkbox
              className="mr-1 size-3.5"
              aria-label={
                file?.path ??
                intl.formatMessage({ id: "git.review.includeDirectoryPage" }, { directory: label })
              }
              checked={reviewTreeCheckState(node, excluded)}
              disabled={actions.disabled}
              data-testid={
                file ? `git-review-include-${file.path}` : `git-review-include-node-${node.id}`
              }
              onCheckedChange={(checked) =>
                checked === true ? actions.restore(paths) : actions.exclude(paths)
              }
            />
          ) : null}
          {file ? (
            <FileDisplayIcon src={resolveFileDisplayDescriptor(file.path).fileIconSrc} size={16} />
          ) : (
            <Folder className="size-4 shrink-0 text-foreground-subtle" />
          )}
          <button
            type="button"
            title={file?.path ?? label}
            aria-current={file === selected ? "true" : undefined}
            onClick={() => (file ? onSelect(file) : toggle(node.id))}
            className={cn(
              "flex h-full min-w-0 flex-1 items-center gap-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
              excluded.has(file?.path ?? "") && "text-foreground-subtlest",
            )}
          >
            <span className={cn("truncate", !file && depth === 0 && "font-medium")}>{label}</span>
            {!file ? (
              <span className="shrink-0 text-ui-sm text-foreground-subtlest">{paths.length}</span>
            ) : null}
            {file && files.some((other) => other !== file && other.path === file.path) ? (
              <span className="shrink-0 text-ui-xs text-foreground-subtle">
                {text(file.staged ? "indexVersion" : "workingVersion")}
              </span>
            ) : null}
          </button>
          {file ? (
            <span className="shrink-0 font-mono text-ui-xs text-foreground-subtle">
              <span className="text-diff-added">+{file.added ?? 0}</span>
              <span className="ml-1 text-diff-removed">−{file.removed ?? 0}</span>
            </span>
          ) : null}
          {file && excluded.has(file.path) ? (
            <span className="sr-only">{text("excluded")}</span>
          ) : null}
        </div>
        {!file && open ? <ul>{node.children.map((child) => render(child, depth + 1))}</ul> : null}
      </li>
    );
  };
  return (
    <>
      <div className="flex h-8 items-center gap-1 border-y border-border px-2 text-ui-sm">
        <span className="min-w-0 flex-1 text-foreground-subtle">{text("filesLabel")}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={text("expandTree")}
          title={text("expandTree")}
          data-testid="git-review-expand-tree"
          onClick={() => setCollapsed(new Set())}
        >
          <ListTreeIcon className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={text("collapseTree")}
          title={text("collapseTree")}
          data-testid="git-review-collapse-tree"
          onClick={() => setCollapsed(new Set(nodes.map((node) => node.id)))}
        >
          <ListCollapseIcon className="size-3.5" />
        </Button>
      </div>
      <ul className="py-1" data-testid="review-workspace-files" aria-label={text("fileScope")}>
        {nodes.map((node) => render(node))}
      </ul>
      {!files.length ? (
        <p className="p-3 text-ui-sm text-foreground-subtle">{text("noFiles")}</p>
      ) : null}
    </>
  );
}
