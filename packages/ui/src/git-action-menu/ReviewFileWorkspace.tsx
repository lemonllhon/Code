import { useMemo, useState, type ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon, MinusIcon, Undo2Icon } from "lucide-react";
import type { PatchCodeViewerSource, ReviewPreviewFile } from "@/lib/codeViewer.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import type { ReviewFileActions } from "@/store/reviewDiffNavigationStore.js";
import { reviewPreviewFileKey } from "./commitReviewFiles.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useReviewDiffNavigationStore } from "@/store/reviewDiffNavigationStore.js";
import { useReviewFileDiff } from "@/hooks/useReviewFileDiff.js";
import { ReviewDiffReturnButton } from "./ReviewDiffReturnButton.js";
import { ReviewFilePagination, useReviewFilePage } from "./ReviewFilePagination.js";
import { ReviewFileTree } from "./ReviewFileTree.js";

const pathOf = (file: ReviewPreviewFile) => file.path;

export function ReviewFileWorkspace({
  source,
  renderDiff,
  fileActions,
  embedded = false,
  revision,
  controls,
  untrackedPaths,
}: {
  source: PatchCodeViewerSource;
  renderDiff: (source: PatchCodeViewerSource) => ReactNode;
  fileActions?: ReviewFileActions;
  embedded?: boolean;
  revision?: number;
  controls?: ReactNode;
  untrackedPaths?: ReadonlySet<string>;
}) {
  const { intl } = useLCodeIntl();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [compactView, setCompactView] = useState<"files" | "diff">("files");
  const files = source.reviewFiles ?? [];
  const page = useReviewFilePage(files, pathOf);
  const file = useMemo(
    () => page.files.find((item) => reviewPreviewFileKey(item) === selectedPath) ?? page.files[0],
    [selectedPath, page.files],
  );
  const entry = useReviewDiffNavigationStore((state) =>
    source.reviewReturnToken ? state.returns[source.reviewReturnToken] : undefined,
  );
  const actions = fileActions ?? entry?.files?.();
  const excluded = useMemo(() => new Set(actions?.excludedFiles ?? []), [actions?.excludedFiles]);
  const diff = useReviewFileDiff(source, source.reviewMetadataOnly ? undefined : file, revision);
  const text = (id: string) => intl.formatMessage({ id: `git.review.${id}` });
  return (
    <section
      className="@container/review-files flex h-full min-h-0 min-w-0 flex-col bg-background"
      data-testid="review-file-workspace"
    >
      {!embedded ? (
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-ui-sm">
          <span className="min-w-0 flex-1 font-medium">{source.title}</span>
          <ReviewDiffReturnButton token={source.reviewReturnToken} />
        </header>
      ) : (
        <nav className="flex shrink-0 gap-1 border-b border-border px-2 py-1 @min-[640px]/review-files:hidden">
          {(["files", "diff"] as const).map((view) => (
            <Button
              key={view}
              type="button"
              size="xs"
              variant="ghost"
              aria-pressed={compactView === view}
              data-testid={`git-review-show-${view}`}
              onClick={() => setCompactView(view)}
            >
              {view === "files" ? text("fileScope") : "Diff"}
            </Button>
          ))}
        </nav>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col @min-[640px]/review-files:flex-row">
        <div
          className={cn(
            source.reviewMetadataOnly
              ? "min-h-0 flex-1 space-y-2 overflow-auto p-3"
              : embedded
                ? "min-h-0 min-w-0 flex-1 overflow-auto border-border @min-[640px]/review-files:w-72 @min-[640px]/review-files:flex-none @min-[640px]/review-files:border-r"
                : "max-h-[45%] shrink-0 space-y-2 overflow-auto border-b border-border p-3 md:max-h-none md:w-72 md:border-b-0 md:border-r",
            embedded && compactView === "diff" && "hidden @min-[640px]/review-files:block",
          )}
          data-testid="git-review-file-list"
        >
          {controls}
          <div className={embedded ? "flex flex-wrap items-start px-1" : undefined}>
            <div className={embedded ? "min-w-32 flex-1" : undefined}>
              <ReviewFilePagination
                model={page}
                compact={embedded}
                onNavigate={() => setSelectedPath(null)}
              />
            </div>
            {actions && !source.reviewMetadataOnly ? (
              <div className={cn("space-y-1 text-ui-sm", embedded && "py-1")}>
                {!embedded ? (
                  <p>
                    {intl.formatMessage(
                      { id: "git.review.scopeCounts" },
                      {
                        selected:
                          files.length - files.filter((item) => excluded.has(item.path)).length,
                        excluded: excluded.size,
                        total: files.length,
                      },
                    )}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-1">
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    data-testid="review-exclude-page"
                    title={text("excludePage")}
                    aria-label={text("excludePage")}
                    className={embedded ? "size-7 p-0" : undefined}
                    disabled={
                      actions.disabled || !page.files.some((item) => !excluded.has(item.path))
                    }
                    onClick={() =>
                      actions.exclude(
                        page.files.filter((item) => !excluded.has(item.path)).map(pathOf),
                      )
                    }
                  >
                    {embedded ? <MinusIcon className="size-3.5" /> : text("excludePage")}
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    data-testid="review-restore-all"
                    title={text("restoreAll")}
                    aria-label={text("restoreAll")}
                    className={embedded ? "size-7 p-0" : undefined}
                    disabled={actions.disabled || !excluded.size}
                    onClick={() => actions.restore([...excluded])}
                  >
                    {embedded ? <Undo2Icon className="size-3.5" /> : text("restoreAll")}
                  </Button>
                  {page.query.trim() ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      className="h-auto min-h-7 whitespace-normal"
                      data-testid="review-exclude-matching"
                      disabled={
                        actions.disabled ||
                        !page.query.trim() ||
                        !page.matchingFiles.some((item) => !excluded.has(item.path))
                      }
                      onClick={() =>
                        actions.exclude(
                          page.matchingFiles.filter((item) => !excluded.has(item.path)).map(pathOf),
                        )
                      }
                    >
                      {intl.formatMessage(
                        { id: "git.review.excludeMatching" },
                        { count: page.matched },
                      )}
                    </Button>
                  ) : null}
                </div>
                {excluded.size && !embedded ? (
                  <p className="text-warning">{text("regenerationRequired")}</p>
                ) : null}
              </div>
            ) : null}
          </div>
          {embedded ? (
            <ReviewFileTree
              files={page.files}
              untrackedPaths={untrackedPaths}
              selected={file}
              excluded={excluded}
              actions={actions}
              onSelect={(item) => {
                setSelectedPath(reviewPreviewFileKey(item));
                setCompactView("diff");
              }}
            />
          ) : (
            <ul className="space-y-1 text-ui-sm" data-testid="review-workspace-files">
              {page.files.map((item) => (
                <li
                  key={reviewPreviewFileKey(item)}
                  className={cn("min-w-0 rounded-md p-1.5", file === item && "bg-selected")}
                >
                  <div className="flex items-start gap-2">
                    <button
                      type="button"
                      className="w-full break-all rounded-sm text-left font-mono hover:bg-hover focus-visible:ring-2 focus-visible:ring-input-border-focused aria-[current=true]:bg-selected"
                      aria-current={file === item ? "true" : undefined}
                      onClick={() => {
                        setSelectedPath(reviewPreviewFileKey(item));
                        setCompactView("diff");
                      }}
                    >
                      {item.path}
                    </button>
                  </div>
                  {excluded.has(item.path) ? (
                    <span className="text-warning"> {text("excluded")}</span>
                  ) : null}
                  {actions && !source.reviewMetadataOnly ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      data-testid={`git-review-${excluded.has(item.path) ? "restore" : "exclude"}-${item.path}`}
                      disabled={actions.disabled}
                      onClick={() =>
                        excluded.has(item.path)
                          ? actions.restore([item.path])
                          : actions.exclude([item.path])
                      }
                    >
                      {text(excluded.has(item.path) ? "restoreFile" : "exclude")}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
        {!source.reviewMetadataOnly ? (
          <div
            className={cn(
              "flex min-h-0 min-w-0 flex-1 flex-col",
              embedded && compactView === "files" && "hidden @min-[640px]/review-files:flex",
            )}
            data-testid="git-review-inline-diff"
          >
            {embedded ? (
              <header className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1 text-ui-sm">
                <span className="min-w-0 flex-1 truncate font-mono" title={file?.path}>
                  {file?.path}
                </span>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={text("previous")}
                  disabled={!file || page.files.indexOf(file) <= 0}
                  onClick={() =>
                    setSelectedPath(
                      reviewPreviewFileKey(page.files[page.files.indexOf(file!) - 1]!),
                    )
                  }
                >
                  <ChevronLeftIcon className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={text("next")}
                  disabled={!file || page.files.indexOf(file) >= page.files.length - 1}
                  onClick={() =>
                    setSelectedPath(
                      reviewPreviewFileKey(page.files[page.files.indexOf(file!) + 1]!),
                    )
                  }
                >
                  <ChevronRightIcon className="size-3.5" />
                </Button>
              </header>
            ) : null}
            <div
              className="min-h-0 min-w-0 flex-1 overflow-auto"
              data-testid="git-review-diff-content"
            >
              {file?.patch === undefined ? (
                <p className="px-3 py-1 text-ui-sm text-warning">{text("liveDiff")}</p>
              ) : null}
              {embedded && file?.patch !== undefined ? (
                <p className="px-3 py-1 text-ui-xs text-foreground-subtle">{text("frozen")}</p>
              ) : null}
              {diff.loading ? (
                <p role="status" className="p-3 text-ui-sm">
                  {text("loadingDiff")}
                </p>
              ) : diff.error ? (
                <p role="alert" className="p-3 text-ui-sm text-warning">
                  {diff.error}
                </p>
              ) : file ? (
                renderDiff({
                  ...source,
                  reviewFiles: undefined,
                  reviewReturnToken: undefined,
                  path: file.path,
                  title: file.path,
                  patch: diff.patch,
                })
              ) : (
                <p className="p-3 text-ui-sm">{text("noFiles")}</p>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
