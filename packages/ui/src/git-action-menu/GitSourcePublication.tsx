import { useState } from "react";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { GitPublicationPortal, useGitPublicationNavigation } from "./GitPublicationPortal.js";
import { Button } from "@/components/ui/button.js";
import { GitPublishOptionsPanel } from "./GitPublishOptionsPanel.js";
import { GitPublishPreview, GitPublishResults } from "./GitPublishFeedback.js";
import type { GitCommitReviewPaneProps } from "./GitCommitReviewPaneProps.js";

export function GitSourcePublication({
  props,
  active,
  canCommit,
  stageCount,
}: {
  props: GitCommitReviewPaneProps;
  active: boolean;
  canCommit: boolean;
  stageCount: number;
}) {
  const { intl } = useLCodeIntl();
  const navigatePublication = useGitPublicationNavigation();
  const [showPreview, setShowPreview] = useState(false);
  const pending = props.mutationPending || props.generationPending || Boolean(props.syncBlocked);
  return (
    <GitPublicationPortal>
      {active ? (
        <section data-testid="git-source-publication" className="min-w-0 text-ui-sm">
          {props.error ? (
            <p role="alert" className="whitespace-pre-wrap break-words px-4 py-2 text-destructive">
              {props.error}
            </p>
          ) : null}
          {props.failureAction}
          {!props.plan && !props.run && !canCommit && stageCount > 0 ? (
            <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-foreground-subtle">
              <p>{intl.formatMessage({ id: "git.publish.reviewFirst" })}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => navigatePublication?.("review")}
              >
                {intl.formatMessage({ id: "git.commitWorkflow.local.title" })}
              </Button>
            </div>
          ) : null}
          {!props.plan && !props.run ? (
            <GitPublishOptionsPanel
              {...props.publish}
              branchName={props.state?.summary.branchName ?? null}
              contextDescription={
                props.executionMode === "worktree"
                  ? intl.formatMessage({ id: "git.commitWorkflow.worktree.publishHint" })
                  : undefined
              }
              disabled={pending || props.loading || !props.state}
              canCommit={canCommit}
              commitUnavailableHint={
                !stageCount ? intl.formatMessage({ id: "git.publish.noCommitChanges" }) : undefined
              }
              remainingGroups={props.review ? props.review.groups.length - props.reviewPosition : 0}
            />
          ) : null}
          {props.plan && (!props.run || showPreview) ? (
            <GitPublishPreview
              plan={props.plan}
              disabled={pending}
              onConfirm={props.onConfirmPublish}
              onCancel={props.run ? () => setShowPreview(false) : props.onCancelPreview}
              readOnly={Boolean(props.run)}
            />
          ) : null}
          {props.run && !showPreview ? (
            <GitPublishResults
              run={props.run}
              refreshStatus={props.publicationRefresh}
              onRefresh={props.onRetryPublicationRefresh}
              onRetry={props.onRetryPublish}
              onReset={() => {
                setShowPreview(false);
                props.onResetPublish();
                if (props.publicationRefresh === "ready" && stageCount > 0)
                  navigatePublication?.("review");
              }}
              onBack={() => setShowPreview(true)}
            />
          ) : null}
        </section>
      ) : null}
    </GitPublicationPortal>
  );
}
