import { GitCommitLoadError } from "./GitCommitLoadError.js";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { LoaderIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ResizableHandle, ResizablePanel } from "@/components/ui/resizable.js";
import { Group as ResizablePanelGroup } from "react-resizable-panels";
import { hasGitCommitIdentity } from "@/git-branch-switcher/switchAssist.js";
import { getGitBranchCommitTotals } from "@/git-branch-switcher/display.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { matchesPrimaryShortcut } from "@/lib/keyboardShortcuts.js";
import { getCommitDialogFiles, getCommitDialogStagePaths } from "./commitDialogModel.js";
import { GitCommitExecutionSummary } from "./GitCommitExecutionSummary.js";
import { GitReviewStageNavigation } from "./GitReviewStageNavigation.js";
import { GitMergeReviewContent } from "./GitMergeReviewContent.js";
import { GitCommitMessageEditor } from "./GitCommitMessageEditor.js";
import { GitReviewFiles } from "./GitReviewFiles.js";
import { GitCommitReviewPanel } from "./GitCommitReviewPanel.js";
import { selectCommitReviewGroup } from "./commitReviewModel.js";
import { GitCommitConfirmAction } from "./GitCommitConfirmAction.js";
import { commitMergeState } from "./commitMergeState.js";
import { GitSourcePublication } from "./GitSourcePublication.js";
import { ReviewActionSlotContext } from "./ReviewActionBar.js";
import { ReviewDialogFooter } from "./ReviewDialogFooter.js";

import type { GitCommitReviewPaneProps } from "./GitCommitReviewPaneProps.js";

export function GitCommitReviewPane(props: GitCommitReviewPaneProps) {
  const { intl } = useLCodeIntl();
  const {
    state,
    review,
    reviewCanSubmit,
    reviewPosition,
    open,
    loading,
    mutationPending,
    generationPending,
    executionMode = "local",
  } = props;
  const dialogElementRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const panelIds = [panelId + "-files", panelId + "-message"];
  const reportVisible = useCallback(() => {
    const element = dialogElementRef.current;
    if (!element?.isConnected) return;
    const style = getComputedStyle(element);
    if (
      element.getBoundingClientRect().width > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) > 0
    )
      props.onVisible();
  }, [props.onVisible]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(reportVisible);
    const observer = new ResizeObserver(reportVisible);
    if (dialogElementRef.current) observer.observe(dialogElementRef.current);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [open, reportVisible]);
  useEffect(() => {
    if (open && props.focusOnOpen) dialogElementRef.current?.focus({ preventScroll: true });
  }, [open, props.focusOnOpen]);
  const [worktreeView, setWorktreeView] = useState<{ id: string; source: boolean } | null>(null);
  const [actionSlot, setActionSlot] = useState<HTMLDivElement | null>(null);
  const { showMerge, sourceLocked } = commitMergeState(
    props.mergeOperationId && props.mergeOperationStatus
      ? { id: props.mergeOperationId, status: props.mergeOperationStatus }
      : undefined,
    props.onMergeViewChange
      ? props.mergeView
      : worktreeView
        ? { operationId: worktreeView.id, source: worktreeView.source }
        : null,
  );
  const actionPending = mutationPending || generationPending;
  const locked = actionPending || sourceLocked || Boolean(props.plan || props.run);
  const hasIdentity = hasGitCommitIdentity(state?.identity ?? null);
  const selectedFiles = state
    ? getCommitDialogFiles(state, props.includeUnstaged, props.excludedFiles)
    : [];
  const stagePaths = state
    ? getCommitDialogStagePaths(state, props.includeUnstaged, props.excludedFiles)
    : [];
  const allFiles = state
    ? [
        ...new Map(
          getCommitDialogFiles(state, true).map((file) => [file.repoRelativePath, file]),
        ).values(),
      ]
    : [];
  const group = selectCommitReviewGroup(review, reviewPosition);
  const totals = getGitBranchCommitTotals(selectedFiles);
  const displayAdded = group
    ? group.files.reduce((sum, file) => sum + file.added, 0)
    : totals.totalAdded;
  const displayRemoved = group
    ? group.files.reduce((sum, file) => sum + file.removed, 0)
    : totals.totalRemoved;
  const commitActionDisabled =
    props.syncBlocked ||
    locked ||
    !reviewCanSubmit ||
    props.requiresRegeneration ||
    Boolean(review && props.browsePosition !== reviewPosition) ||
    !stagePaths.length ||
    (!hasIdentity && state?.identity !== null);
  const canCommit = !commitActionDisabled && hasIdentity && Boolean(props.message.trim());
  const workflowText = (field: string) =>
    intl.formatMessage({ id: `git.commitWorkflow.${executionMode}.${field}` });
  return (
    <ReviewActionSlotContext.Provider value={actionSlot}>
      <section
        ref={dialogElementRef}
        tabIndex={-1}
        style={open ? undefined : { display: "none" }}
        aria-label={workflowText("title")}
        onAnimationEnd={reportVisible}
        data-testid="git-commit-review-pane"
        data-review-visible={open ? "true" : "false"}
        className="relative z-10 flex h-full min-h-0 min-w-0 flex-col overflow-clip bg-background [overflow-wrap:anywhere]"
      >
        <h2 className="sr-only" data-testid="git-commit-workflow-title">
          {workflowText("title")}
        </h2>
        {props.syncStatus}
        {loading ? (
          <div
            role="status"
            className="flex h-56 items-center justify-center gap-2 px-5 py-5 text-ui-sm text-foreground-subtle"
          >
            <LoaderIcon className="size-5 animate-spin" />
            {intl.formatMessage({ id: "git.commitWorkflow.loading" })}
          </div>
        ) : state ? (
          <form
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-clip"
            onSubmit={(event) => {
              event.preventDefault();
              if (!showMerge && !commitActionDisabled) props.onSubmit();
            }}
            onKeyDownCapture={(event) => {
              if (!matchesPrimaryShortcut(event, "Enter")) return;
              // 合并结果不属于来源提交表单；快捷键既不能提交隐藏的来源改动，也不能升级为网络发布。
              event.preventDefault();
              event.stopPropagation();
              if (!showMerge && !commitActionDisabled) props.onSubmit();
            }}
          >
            <div className="shrink-0 border-b border-border">
              {/* 合并结果属于原项目目标目录；来源分支切换器只在来源提交视图展示，避免发布对象混淆。 */}
              {!showMerge ? (
                <GitCommitExecutionSummary
                  workspacePath={props.workspacePath}
                  workspaceIdentity={props.workspaceIdentity}
                  workspaceRemoteSessionId={props.workspaceRemoteSessionId}
                  executionMode={executionMode}
                  summary={state.summary}
                  locked={locked}
                  fileCount={allFiles.length}
                  added={displayAdded}
                  removed={displayRemoved}
                  onRefreshGit={props.onRefreshGit}
                />
              ) : null}
              {props.mergeOperationId ? (
                <GitReviewStageNavigation
                  showMerge={showMerge}
                  publishedTarget={
                    props.mergeOperationStatus &&
                    ["published", "up-to-date"].includes(props.mergeOperationStatus)
                      ? props.mergeTargetBranch
                      : undefined
                  }
                  disabled={Boolean(props.syncBlocked || actionPending || props.run?.running)}
                  onBack={() =>
                    props.onMergeViewChange
                      ? props.onMergeViewChange({
                          operationId: props.mergeOperationId!,
                          source: showMerge,
                        })
                      : setWorktreeView({ id: props.mergeOperationId!, source: showMerge })
                  }
                />
              ) : null}
            </div>
            <div className="min-h-0 min-w-0 flex-1 overflow-clip" data-testid="git-review-body">
              {showMerge ? (
                <div className="h-full overflow-y-auto" data-testid="git-review-scroll">
                  <GitMergeReviewContent
                    canOpenFiles={props.canOpenFiles}
                    onOpenFiles={() => props.onOpenFiles(true)}
                  >
                    {props.worktreeMergeActions}
                  </GitMergeReviewContent>
                </div>
              ) : (
                <ResizablePanelGroup orientation="vertical">
                  <ResizablePanel id={panelIds[0]!} defaultSize="55%" minSize="100px">
                    <GitReviewFiles
                      props={props}
                      locked={locked}
                      sourceLocked={sourceLocked}
                      stageCount={stagePaths.length}
                      totalCount={allFiles.length}
                    />
                  </ResizablePanel>
                  <ResizableHandle />
                  <ResizablePanel id={panelIds[1]!} defaultSize="45%" minSize="140px">
                    <div
                      className="h-full min-w-0 overflow-y-auto overscroll-contain py-2"
                      data-testid="git-review-scroll"
                    >
                      <GitCommitMessageEditor
                        message={props.message}
                        previousMessage={props.previousMessage}
                        disabled={locked}
                        generationPending={generationPending}
                        canGenerate={!props.syncBlocked && stagePaths.length > 0 && hasIdentity}
                        onMessageChange={props.onMessageChange}
                        onGenerate={props.onGenerateMessage}
                        onCopy={props.onCopyMessage}
                        onRestore={props.onRestoreMessage}
                      />
                      {props.requiresRegeneration ? (
                        <p role="alert" className="px-4 py-2 text-ui-sm text-warning">
                          {intl.formatMessage({ id: "git.review.regenerationRequired" })}
                        </p>
                      ) : null}
                      {props.reviewError ? (
                        <div className="space-y-2 px-4 py-2 text-ui-sm" role="alert">
                          <p className="break-words text-warning">{props.reviewError}</p>
                          {!props.requiresRegeneration ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={locked}
                              onClick={props.onManualFallback}
                            >
                              {intl.formatMessage({ id: "git.review.manual" })}
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                      {review ? (
                        <GitCommitReviewPanel
                          review={review}
                          position={reviewPosition}
                          browsePosition={props.browsePosition}
                          acknowledged={props.reviewAcknowledged}
                          disabled={locked}
                          navigationDisabled={actionPending}
                          onBrowse={props.onBrowse}
                          onAcknowledge={props.onReviewAcknowledge}
                          onManualFallback={props.onManualFallback}
                        />
                      ) : null}
                      {!hasIdentity ? (
                        <p className="px-4 py-2 text-ui-sm text-warning">
                          {intl.formatMessage({
                            id: "git.actionMenu.commitDialog.identityMissing",
                          })}
                        </p>
                      ) : null}
                      {props.error ? (
                        <p
                          role="alert"
                          className="whitespace-pre-wrap break-words px-4 py-2 text-ui-sm text-destructive"
                        >
                          {props.error}
                        </p>
                      ) : null}
                      {props.failureAction}
                      {props.worktreeActions}
                      <GitCommitConfirmAction
                        secondary={executionMode === "worktree"}
                        disabled={commitActionDisabled}
                        pending={mutationPending}
                        label={workflowText("commit")}
                        onSubmit={props.onSubmit}
                      />
                    </div>
                  </ResizablePanel>
                </ResizablePanelGroup>
              )}
            </div>
            <ReviewDialogFooter
              onClose={() => props.onOpenChange(false)}
              actionSlotRef={setActionSlot}
            />
          </form>
        ) : (
          <GitCommitLoadError
            error={props.error}
            failureAction={props.failureAction}
            onClose={() => props.onOpenChange(false)}
            onRetry={props.onRetryLoad}
          />
        )}
      </section>
      <GitSourcePublication
        props={props}
        active={!showMerge}
        canCommit={canCommit}
        stageCount={stagePaths.length}
      />
    </ReviewActionSlotContext.Provider>
  );
}
