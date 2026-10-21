import type { GitCommitReview } from "@lcode/shared";
import type { ReviewPreviewFile } from "@/lib/codeViewer.js";
import type { GitCommitDialogState } from "./commitDialogModel.js";

export function reviewPreviewFileKey(file: ReviewPreviewFile): string {
  return JSON.stringify([file.path, file.staged ?? null]);
}

export function commitReviewFiles(
  state: GitCommitDialogState | null,
  review: GitCommitReview | null,
  browsePosition: number,
): readonly ReviewPreviewFile[] {
  const frozen = review?.groups[browsePosition]?.files;
  if (frozen) return frozen;
  if (!state) return [];
  // 同一路径可能同时有 index 和 working 两个不同版本，不能用 Map(path) 静默覆盖。
  return [
    ...state.unstagedFiles.map((file) => ({
      path: file.repoRelativePath,
      staged: false,
      added: file.added,
      removed: file.removed,
    })),
    ...state.stagedFiles.map((file) => ({
      path: file.repoRelativePath,
      staged: true,
      added: file.added,
      removed: file.removed,
    })),
  ];
}
