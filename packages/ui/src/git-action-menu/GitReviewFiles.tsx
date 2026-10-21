import type { GitCommitReviewPaneProps } from "./GitCommitReviewPaneProps.js";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { useLCodeStore } from "@/store/StoreProvider.js";
import { resolveTheme } from "@/useTheme.js";
import { PatchFallbackContent } from "@/previewPanePatchFallbackContent.js";
import { ReviewFileWorkspace } from "./ReviewFileWorkspace.js";
import { commitReviewFiles } from "./commitReviewFiles.js";
import { GitCommitFileScope } from "./GitCommitFileScope.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function GitReviewFiles({
  props,
  locked,
  sourceLocked,
  stageCount,
  totalCount,
}: {
  props: GitCommitReviewPaneProps;
  locked: boolean;
  sourceLocked: boolean;
  stageCount: number;
  totalCount: number;
}) {
  const { intl } = useLCodeIntl();
  const settings = useLCodeStore((state) => state.codePreviewSettings);
  const theme = useLCodeStore((state) => state.theme);
  const [rangeReviewId, setRangeReviewId] = useState<string | null>(null);
  const currentGroup = Boolean(
    props.review &&
    props.browsePosition === props.reviewPosition &&
    props.reviewPosition < props.review.groups.length,
  );
  // 实时管理只属于发起它的审核快照；不能依赖加载时的卸载来重置，也不能带入历史组。
  const manageRange = currentGroup && rangeReviewId === props.review?.id;
  const files = useMemo(
    () => commitReviewFiles(props.state, manageRange ? null : props.review, props.browsePosition),
    [props.state, props.review, props.browsePosition, manageRange],
  );
  const untracked = useMemo(
    () =>
      new Set(
        props.state?.unstagedFiles
          .filter((file) => file.isUntracked)
          .map((file) => file.repoRelativePath),
      ),
    [props.state],
  );
  return (
    <ReviewFileWorkspace
      embedded
      revision={props.diffRevision}
      untrackedPaths={untracked}
      fileActions={
        sourceLocked
          ? undefined
          : { ...props.fileActions, disabled: props.fileActions.disabled || locked }
      }
      source={{
        type: "patch",
        title: intl.formatMessage({ id: "git.review.fileScope" }),
        patch: "",
        workspacePath: props.workspacePath,
        workspaceIdentity: props.workspaceIdentity,
        workspaceRemoteSessionId: props.workspaceRemoteSessionId,
        reviewFiles: files,
      }}
      controls={
        <>
          <GitCommitFileScope
            includeUnstaged={props.includeUnstaged}
            hasUnstaged={Boolean(props.state?.unstagedFiles.length)}
            fileCount={stageCount}
            totalCount={totalCount}
            excludedCount={props.excludedFiles.length}
            disabled={locked}
            readOnly={sourceLocked}
            onIncludeUnstagedChange={props.onIncludeUnstagedChange}
          />
          {props.review && currentGroup && !sourceLocked ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-testid="git-review-manage-range"
              aria-pressed={manageRange}
              onClick={() => setRangeReviewId(manageRange ? null : (props.review?.id ?? null))}
            >
              {intl.formatMessage({
                id: manageRange ? "git.review.showFrozen" : "git.review.manageRangeInline",
              })}
            </Button>
          ) : null}
        </>
      }
      renderDiff={(source) => (
        <PatchFallbackContent
          patch={source.patch}
          sourcePath={source.path}
          sourceTitle={source.title}
          codePreviewSettings={settings}
          resolvedTheme={resolveTheme(theme)}
        />
      )}
    />
  );
}
