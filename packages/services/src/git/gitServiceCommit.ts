import {
  gitCommitAndSwitchRequestSchema,
  type GitCommitAndSwitchRequest,
  type GitCommitAndSwitchResult,
  type GitCommitRequest,
  type GitCommitResult,
} from "@lcode/shared";
import type { CommitReviewService } from "./commitReviewService.js";
import type { GitCliRepo } from "./repo/gitCliTypes.js";
import type { GitPublishStateReader } from "./repo/gitPublishState.js";
import { resolveMutationSelection } from "./repo/gitFileMutationRepo.js";
import { resolve } from "node:path";

export async function commitAndSwitchWithPublishState(
  repo: GitCliRepo,
  reviews: CommitReviewService | null,
  state: GitPublishStateReader,
  input: GitCommitAndSwitchRequest,
): Promise<GitCommitAndSwitchResult> {
  const params = gitCommitAndSwitchRequestSchema.parse(input);
  const snapshot = await repo.getStatus(params.workspacePath);
  const { paths } = await resolveMutationSelection(snapshot, params.paths);
  const commit = await commitWithPublishState(repo, reviews, state, {
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    message: params.message,
    paths: paths.map((path) => resolve(snapshot.resolution.repoRoot, path)),
    expectedState: params.expectedState,
  });
  // 已完成提交是不可丢失的事实；警告或切换失败都不能诱发 UI 重复提交。
  if (commit.warning) return { commit, switchResult: null, warning: commit.warning };
  try {
    const switchResult = await repo.switchBranch(params.workspacePath, params.targetBranchName);
    return { commit, switchResult };
  } catch (error) {
    return {
      commit,
      switchResult: null,
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function commitWithPublishState(
  repo: GitCliRepo,
  reviews: CommitReviewService | null,
  state: GitPublishStateReader,
  params: GitCommitRequest,
): Promise<GitCommitResult> {
  const expected = params.expectedState;
  let committed: GitCommitResult;
  if (params.review) {
    if (!reviews) throw new Error("提交审核不可用。");
    committed = {
      ...(await reviews.commit(
        params,
        expected ? () => state.assertCurrent(params.workspacePath, expected) : undefined,
      )),
    };
  } else {
    const summary = (await repo.getStatus(params.workspacePath)).summary;
    if (params.expectedState) await state.assertCurrent(params.workspacePath, params.expectedState);
    committed = {
      ...(await repo.commit(params.workspacePath, params.message, params.paths, {
        stagedOnly: params.stagedOnly,
      })),
      summary,
    };
  }
  // 中文依据：commitHash 是已完成事实，后续状态刷新/Hook/并发检测失败只能附警告，不能谎报未提交诱发重复提交。
  try {
    repo.invalidate(params.workspacePath);
    committed = { ...committed, summary: (await repo.getStatus(params.workspacePath)).summary };
  } catch {
    committed.warning ??= "提交已成功，但状态刷新失败，请刷新后查看。";
  }
  if (params.expectedState) {
    try {
      const next = await state.capture(params.workspacePath);
      if (
        next.headCommitHash !== committed.commitHash ||
        next.branchName !== params.expectedState.branchName ||
        next.worktreeFingerprint !== params.expectedState.worktreeFingerprint
      ) {
        throw new Error("HEAD、分支或工作树在提交后发生变化，请重新确认发布。");
      }
      if (!committed.warning) committed.publishState = next;
    } catch (error) {
      committed.warning = [
        committed.warning,
        `提交已成功，但${error instanceof Error ? error.message : String(error)}`,
      ]
        .filter(Boolean)
        .join("\n");
      delete committed.publishState;
    }
  }
  return committed;
}
