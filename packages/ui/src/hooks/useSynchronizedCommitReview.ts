import { useEffect, useRef } from "react";
import { useServices } from "./useServices.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import type { useReviewWorkspaceState } from "./useReviewWorkspaceState.js";
import type { useGitCommitReview } from "./useGitCommitReview.js";

export function useSynchronizedCommitReview(
  workspace: ReturnType<typeof useReviewWorkspaceState>,
  review: ReturnType<typeof useGitCommitReview>,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  onChanged: () => void,
) {
  const { gitService } = useServices();
  const { intl } = useLCodeIntl();
  const callback = useRef(onChanged);
  callback.current = onChanged;
  const current = useRef(review);
  current.current = review;
  const id = workspace.data.sourceReview?.id;
  const revision = workspace.snapshot.fieldRevisions.sourceReview;
  const changedKey = JSON.stringify([
    workspace.remoteFieldRevisions.draft,
    workspace.remoteFieldRevisions.excludedFiles,
    workspace.remoteFieldRevisions.selectedPaths,
    workspace.remoteFieldRevisions.includeUnstaged,
    workspace.remoteFieldRevisions.sourceReview,
  ]);
  useEffect(() => {
    callback.current();
  }, [changedKey]);
  useEffect(() => {
    if (workspace.status === "loading") return;
    if (workspace.read().data.sourceReview?.id !== id) return;
    let disposed = false;
    if (!id) {
      if (revision > 0 && current.current.review) current.current.clear();
      return;
    }
    // 旧读取可能晚于提交清理或另端替换返回；再次核对 Host 引用版本，不能复活过期提示。
    const isCurrent = () =>
      !disposed &&
      workspace.read().data.sourceReview?.id === id &&
      workspace.read().snapshot.fieldRevisions.sourceReview === revision;
    void gitService
      .getCommitReview({ workspacePath, workspaceIdentity, reviewId: id })
      .then((snapshot) => {
        if (!isCurrent()) return;
        if (!snapshot) {
          current.current.adopt(undefined, undefined, "");
          workspace.patch({
            sourceReview: null,
            draft: { ...workspace.read().data.draft, requiresRegeneration: true },
          });
        } else if (
          current.current.review?.id !== snapshot.review.id ||
          current.current.position !== snapshot.position
        ) {
          current.current.hydrate(snapshot.review, snapshot.position);
        }
      })
      .catch(() => {
        if (isCurrent())
          current.current.adopt(
            undefined,
            undefined,
            intl.formatMessage({ id: "git.review.unavailable" }),
          );
      });
    return () => {
      disposed = true;
    };
  }, [
    id,
    revision,
    gitService,
    workspacePath,
    workspaceIdentity,
    workspace.patch,
    workspace.read,
    workspace.status === "loading",
  ]);
}
