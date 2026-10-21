import type { GitCommitReview, GitReviewWorkspaceData } from "@lcode/shared";

/** 提交收据只产生一个审核状态补丁，避免另一端看到新草稿与旧范围的中间状态。 */
export function commitReviewCompletionPatch(
  data: GitReviewWorkspaceData,
  review: GitCommitReview | null,
  nextPosition: number,
  warning?: string,
): Partial<GitReviewWorkspaceData> {
  if (warning)
    return {
      draft: { ...data.draft, requiresRegeneration: true },
      sourceReview: data.sourceReview ?? (review ? { id: review.id } : null),
    };
  const next = review?.groups[nextPosition];
  const draft = {
    message: next?.message ?? "",
    previousMessage: null,
    edited: false,
    requiresRegeneration: false,
  };
  return next
    ? { draft, sourceReview: { id: review!.id }, browsePosition: nextPosition }
    : {
        draft,
        sourceReview: null,
        selectedPaths: null,
        excludedFiles: [],
        browsePosition: 0,
        includeUnstaged: true,
      };
}
