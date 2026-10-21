import type { IGitService } from "@lcode/services";
import type {
  GitBranchMutationIssue,
  GitBranchMutationResult,
  GitIdentity,
  GitPublishState,
} from "@lcode/shared";
import {
  buildGitBranchCommitPreviewFiles,
  getPrimaryGitBranchIssue,
  getGitBranchCommitTotals,
  isGitBranchCommitAssistIssue,
  selectGitBranchAffectedFiles,
  type GitBranchCommitPreviewFile,
} from "@/git-branch-switcher/display.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";
import { joinFilePath } from "@/lib/path.js";

export type GitBranchSwitchAssistDialogStep = "blocked" | "commit";

export interface GitBranchSwitchAssistState {
  targetBranchName: string;
  currentBranchName: string | null;
  issue: GitBranchMutationIssue;
  affectedFiles: GitBranchCommitPreviewFile[];
  commitFiles: GitBranchCommitPreviewFile[];
  stagePaths: string[];
  fileCount: number;
  totalAdded: number;
  totalRemoved: number;
  identity: GitIdentity | null;
  expectedState: GitPublishState;
}

export function formatGitBranchIssuePathList(locale: string, paths: readonly string[]): string {
  if (paths.length === 0) {
    return "";
  }

  return new Intl.ListFormat(locale, {
    style: "short",
    type: "conjunction",
  }).format(paths);
}

export function hasGitCommitIdentity(identity: GitIdentity | null): boolean {
  return identity === null || (Boolean(identity.userName) && Boolean(identity.userEmail));
}

export async function buildGitBranchSwitchAssistState(options: {
  gitService: IGitService;
  workspacePath: string;
  workspaceIdentity?: string;
  result: GitBranchMutationResult;
}): Promise<GitBranchSwitchAssistState | null> {
  const issue = getPrimaryGitBranchIssue(options.result.issues);
  if (!issue || !isGitBranchCommitAssistIssue(issue.code) || !options.result.branchName) {
    return null;
  }
  const request = {
    workspacePath: options.workspacePath,
    workspaceIdentity: options.workspaceIdentity,
  };
  const expectedState = await options.gitService.getPublishState(request);

  const [unstagedChangesResult, stagedChangesResult, identityResult] = await Promise.allSettled([
    options.gitService.getChanges({
      ...request,
      sourceId: "unstaged",
    }),
    options.gitService.getChanges({
      ...request,
      sourceId: "staged",
    }),
    options.gitService.getIdentity(request),
  ]);

  if (unstagedChangesResult.status === "rejected") {
    logger.warn("[GitBranchSwitcher] 读取 unstaged 更改失败", {
      workspacePath: options.workspacePath,
      error: getErrorMessage(unstagedChangesResult.reason),
    });
  }
  if (stagedChangesResult.status === "rejected") {
    logger.warn("[GitBranchSwitcher] 读取 staged 更改失败", {
      workspacePath: options.workspacePath,
      error: getErrorMessage(stagedChangesResult.reason),
    });
  }
  if (identityResult.status === "rejected") {
    logger.warn("[GitBranchSwitcher] 读取提交身份失败", {
      workspacePath: options.workspacePath,
      error: getErrorMessage(identityResult.reason),
    });
  }
  if (
    unstagedChangesResult.status === "rejected" ||
    stagedChangesResult.status === "rejected" ||
    identityResult.status === "rejected"
  )
    return null;

  const unstagedChanges =
    unstagedChangesResult.status === "fulfilled" ? unstagedChangesResult.value : [];
  const stagedChanges = stagedChangesResult.status === "fulfilled" ? stagedChangesResult.value : [];
  const allFiles = buildGitBranchCommitPreviewFiles([...unstagedChanges, ...stagedChanges]);
  const affectedFiles = selectGitBranchAffectedFiles({
    files: allFiles,
    issuePaths: issue.paths,
  });
  // 切换辅助只提交界面列出的阻塞文件，不能把无关已暂存内容混入提交。
  const commitFiles = affectedFiles;
  const stagePaths = [
    ...new Set(
      commitFiles.map((file) =>
        joinFilePath(
          options.result.summary.repoRoot ?? options.workspacePath,
          file.repoRelativePath,
        ),
      ),
    ),
  ];
  const { fileCount, totalAdded, totalRemoved } = getGitBranchCommitTotals(commitFiles);

  return {
    targetBranchName: options.result.branchName,
    currentBranchName: options.result.summary.branchName,
    issue,
    affectedFiles,
    commitFiles,
    stagePaths,
    fileCount,
    totalAdded,
    totalRemoved,
    identity: identityResult.status === "fulfilled" ? identityResult.value : null,
    expectedState,
  };
}
