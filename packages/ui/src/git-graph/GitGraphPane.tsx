import { GitGraph, RefreshCwIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type UIEvent } from "react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { GitGraphCommitDetail } from "./GitGraphCommitDetail.js";
import { GitGraphRow, responsiveColumns, wideColumns, type CommitAction } from "./GitGraphRow.js";
import { useGitGraphViewport } from "@/hooks/useGitGraphViewport.js";
import { useLCodeStore } from "@/store/StoreProvider.js";
import { useGitGraphColumns } from "@/hooks/useGitGraphColumns.js";
import { type GitGraphCommit, type GitGraphLayoutPath, layoutGitGraph } from "./layout.js";

interface GitGraphPaneProps {
  commits: readonly GitGraphCommit[];
  marked?: readonly string[];
  onToggleCommit?: (hash: string) => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  refreshing?: boolean;
  showInlineDetail?: boolean;
  compact?: boolean;
  disabled?: boolean;
  commitTestId?: string;
  loadMoreTestId?: string;
  limitReached?: boolean;
  selectedCommitHash: string | null;
  onSelectCommit: (hash: string) => void;
  onCommitAction?: (hash: string, action: CommitAction) => void;
  onLoadMore?: () => void;
  onRefresh?: () => void;
}
const laneStrokeClasses = [
  "stroke-git-descendant",
  "stroke-git-renamed",
  "stroke-git-added",
  "stroke-git-modified",
];
const laneFillClasses = [
  "fill-git-descendant",
  "fill-git-renamed",
  "fill-git-added",
  "fill-git-modified",
];
function isPathRelated(path: GitGraphLayoutPath, hash: string | null) {
  return Boolean(hash && path.relatedHashes.includes(hash));
}

export function GitGraphPane({
  commits,
  marked = [],
  onToggleCommit,
  hasMore = false,
  loadingMore = false,
  refreshing = false,
  showInlineDetail = true,
  compact = false,
  disabled = false,
  commitTestId,
  loadMoreTestId,
  limitReached = false,
  selectedCommitHash,
  onSelectCommit,
  onCommitAction,
  onLoadMore,
  onRefresh,
}: GitGraphPaneProps) {
  const { intl } = useLCodeIntl();
  const fontSize = useLCodeStore((state) => state.uiFontSizePx);
  const compactHeight = Math.max(40, Math.ceil(fontSize * 2.8));
  const [hoveredCommitHash, setHoveredCommitHash] = useState<string | null>(null);
  const [expandedCommitHash, setExpandedCommitHash] = useState<string | null>(null);
  const columns = useGitGraphColumns();
  const [cursor, setCursor] = useState<string>();
  const elements = useRef(new Map<string, HTMLButtonElement>());
  const active = commits.some((item) => item.hash === cursor)
    ? cursor
    : (selectedCommitHash ?? commits[0]?.hash);
  const layout = useMemo(
    () =>
      layoutGitGraph(
        commits,
        compact
          ? {
              rowHeight: compactHeight,
              topPadding: compactHeight / 2,
              bottomPadding: compactHeight / 2,
              lanePadding: 12,
              laneGap: 16,
            }
          : {},
      ),
    [commits, compact, compactHeight],
  );
  const viewport = useGitGraphViewport(commits.length, layout.rowHeight, commits[0]?.hash);
  const pendingFocus = useRef<string | null>(null);
  const visibleRows = layout.rows.slice(viewport.start, viewport.end);
  const pathPositions = useMemo(() => {
    const positions = new Map(commits.map((commit, index) => [commit.hash, index]));
    return layout.paths.map((path) => {
      const indexes = path.relatedHashes.map((hash) => positions.get(hash) ?? commits.length);
      return { path, min: Math.min(...indexes), max: Math.max(...indexes) };
    });
  }, [commits, layout]);
  const graphColumnWidth = Math.max(layout.width + 8, compact ? 36 : 56);
  const expandedCommit = commits.find((commit) => commit.hash === expandedCommitHash) ?? null;
  const graphHeight = compact ? layout.height : layout.height + layout.rowHeight;
  const handleGraphScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (!hasMore || limitReached || loadingMore || disabled || !onLoadMore) return;
      const target = event.currentTarget;
      if (target.scrollHeight - target.scrollTop - target.clientHeight <= 96) onLoadMore();
    },
    [hasMore, limitReached, loadingMore, disabled, onLoadMore],
  );
  const metaClass = compact ? "hidden @min-[620px]/gitgraph:block" : "";
  return (
    <section
      style={columns.style}
      className="@container/gitgraph flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground"
    >
      {!compact ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface/40 px-3 py-2">
          <GitGraph className="size-3.5" />
          <h2 className="min-w-0 flex-1 truncate text-ui-base font-medium">
            {intl.formatMessage({ id: "gitGraph.title" })}
          </h2>
          {onRefresh ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={refreshing}
              aria-label={intl.formatMessage({ id: "gitGraph.refresh" })}
              title={intl.formatMessage({ id: "gitGraph.refresh" })}
              onClick={onRefresh}
            >
              <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
            </Button>
          ) : null}
        </div>
      ) : null}
      {commits.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="max-w-sm text-center">
            <GitGraph className="mx-auto size-8 text-foreground-subtlest" />
            <p className="mt-3 text-ui-base font-medium">
              {intl.formatMessage({ id: "gitGraph.empty.title" })}
            </p>
            <p className="mt-1 text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "gitGraph.empty.description" })}
            </p>
          </div>
        </div>
      ) : (
        <div
          className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain"
          ref={viewport.attach}
          onScroll={(event) => {
            viewport.scroll(event);
            handleGraphScroll(event);
          }}
          data-testid={compact ? "git-history-scroll" : undefined}
        >
          {/* 单一滚动区让表头保持可见；图形与提交行共用高度，窄栏不再渲染另一份无图列表。 */}
          <div
            className="grid"
            style={{
              gridTemplateColumns: `${graphColumnWidth}px minmax(0,1fr)`,
              minWidth: compact ? graphColumnWidth + 200 : 760,
            }}
          >
            <div className="sticky top-0 z-10 border-b border-border bg-background px-2 py-1.5 text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "gitGraph.column.graph" })}
            </div>
            <div
              className={cn(
                "sticky top-0 z-10 grid items-center border-b border-border bg-background text-ui-xs text-foreground-subtle",
                compact && responsiveColumns,
              )}
              style={compact ? undefined : wideColumns}
            >
              <div className="px-2 py-1.5">
                {intl.formatMessage({ id: "gitGraph.column.description" })}
              </div>
              {(["date", "author", "commit"] as const).map((column) => (
                <div key={column} className={cn("relative px-2 py-1.5", metaClass)}>
                  {intl.formatMessage({ id: `gitGraph.column.${column}` })}
                  <span
                    {...columns.handles(column)}
                    aria-label={intl.formatMessage(
                      { id: "git.history.resizeColumn" },
                      { column: intl.formatMessage({ id: `gitGraph.column.${column}` }) },
                    )}
                    className="absolute right-0 top-0 h-full w-3 touch-none cursor-col-resize border-r border-border hover:bg-hover focus-visible:bg-selected focus-visible:outline-1 focus-visible:outline-input-border-focused"
                  />
                </div>
              ))}
            </div>
            <div className="relative overflow-hidden" style={{ height: graphHeight }}>
              <svg
                className="absolute inset-0"
                width={graphColumnWidth}
                height={graphHeight}
                viewBox={`0 0 ${graphColumnWidth} ${graphHeight}`}
                role="img"
                aria-label={intl.formatMessage({ id: "gitGraph.graphAriaLabel" })}
              >
                {pathPositions
                  .filter(({ min, max }) => min <= viewport.end && max >= viewport.start)
                  .map(({ path }) => (
                    <path
                      key={path.id}
                      d={path.path}
                      className={cn(
                        "fill-none stroke-[2] opacity-80 transition-opacity",
                        laneStrokeClasses[path.laneIndex % laneStrokeClasses.length],
                        hoveredCommitHash &&
                          !isPathRelated(path, hoveredCommitHash) &&
                          "opacity-30",
                        isPathRelated(path, hoveredCommitHash) && "opacity-100",
                      )}
                    />
                  ))}
                {visibleRows.map((row) => (
                  <g key={row.commit.hash}>
                    <circle
                      cx={row.x}
                      cy={row.y}
                      r={row.commit.hash === selectedCommitHash ? 4.25 : 3.5}
                      className={cn(
                        "stroke-background stroke-[1.5]",
                        laneFillClasses[row.laneIndex % laneFillClasses.length],
                      )}
                    />
                    {row.commit.hash === selectedCommitHash ? (
                      <circle
                        cx={row.x}
                        cy={row.y}
                        r={5.5}
                        className={cn(
                          "fill-none stroke-[1]",
                          laneStrokeClasses[row.laneIndex % laneStrokeClasses.length],
                        )}
                      />
                    ) : null}
                  </g>
                ))}
              </svg>
            </div>
            <div
              className="min-w-0"
              style={{
                height: commits.length * layout.rowHeight,
                paddingTop: viewport.start * layout.rowHeight,
              }}
            >
              {visibleRows.map((row) => (
                <GitGraphRow
                  key={row.commit.hash}
                  commit={row.commit}
                  checked={marked.includes(row.commit.hash)}
                  onToggle={onToggleCommit ? () => onToggleCommit(row.commit.hash) : undefined}
                  compact={compact}
                  disabled={disabled}
                  height={layout.rowHeight}
                  selected={row.commit.hash === selectedCommitHash}
                  testId={commitTestId}
                  tabIndex={active === row.commit.hash ? 0 : -1}
                  elementRef={(el) => {
                    if (el) {
                      elements.current.set(row.commit.hash, el);
                      if (pendingFocus.current === row.commit.hash) {
                        pendingFocus.current = null;
                        el.focus();
                      }
                    } else elements.current.delete(row.commit.hash);
                  }}
                  onSelect={() => {
                    setCursor(row.commit.hash);
                    onSelectCommit(row.commit.hash);
                    if (showInlineDetail)
                      setExpandedCommitHash((old) =>
                        old === row.commit.hash ? null : row.commit.hash,
                      );
                  }}
                  onNavigate={(event) => {
                    const offset =
                      event.key === "ArrowUp"
                        ? -1
                        : event.key === "ArrowDown"
                          ? 1
                          : event.key === "PageUp"
                            ? -10
                            : event.key === "PageDown"
                              ? 10
                              : 0;
                    if (!offset && event.key !== "Home" && event.key !== "End") return;
                    event.preventDefault();
                    const next =
                      commits[
                        event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? commits.length - 1
                            : Math.max(0, Math.min(commits.length - 1, row.rowIndex + offset))
                      ];
                    if (next) {
                      setCursor(next.hash);
                      pendingFocus.current = next.hash;
                      viewport.reveal(commits.indexOf(next));
                      const element = elements.current.get(next.hash);
                      if (element) {
                        pendingFocus.current = null;
                        element.focus();
                      }
                      onSelectCommit(next.hash);
                    }
                  }}
                  onHover={setHoveredCommitHash}
                  onAction={onCommitAction}
                />
              ))}
            </div>
          </div>
        </div>
      )}
      {limitReached ? (
        <p
          className="shrink-0 border-t border-border px-2 py-1 text-ui-xs text-foreground-subtle"
          data-testid="git-history-limit"
        >
          {intl.formatMessage({ id: "git.history.loadLimit" })}
        </p>
      ) : hasMore && onLoadMore ? (
        <div className="flex shrink-0 items-center justify-end border-t border-border px-2 py-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={loadingMore || disabled}
            data-testid={loadMoreTestId}
            onClick={onLoadMore}
          >
            {intl.formatMessage({
              id: loadingMore ? "gitGraph.loadMore.loading" : "gitGraph.loadMore",
            })}
          </Button>
        </div>
      ) : null}
      {showInlineDetail && expandedCommit ? <GitGraphCommitDetail commit={expandedCommit} /> : null}
    </section>
  );
}
