import type {
  GitBranchMutationResult,
  GitDeleteBranchRequest,
  GitDeleteBranchResult,
  GitBranchComparison,
  GitCommitGraphRequest,
  GitCommitGraphResult,
  GitCreateBranchRequest,
  GitChangesRequest,
  GitCommitRequest,
  GitCommitResult,
  GitCommitAndSwitchRequest,
  GitCommitAndSwitchResult,
  GitDiffQuery,
  GitDiffResult,
  GitDiscardPathsRequest,
  GitGenerateCommitMessageRequest,
  GitGenerateCommitMessageResult,
  GitIdentity,
  GitIgnoredPathsRequest,
  GitLocalBranchListResult,
  GitPathMutationRequest,
  GitPushRequest,
  GitPushResult,
  GitPublishState,
  GitPublicationRequest,
  GitRemoteListResult,
  GitTagListResult,
  GitCreateTagRequest,
  GitCreateTagResult,
  GitRefreshRequest,
  GitRefreshResult,
  GitRepositoryRequest,
  GitRepositorySummary,
  GitWorkspaceRepositoryInfo,
  GitFileChange,
  GitSwitchBranchRequest,
  GitNetworkSnapshot,
  GitRemoteMutationRequest,
  GitTrackingRequest,
  GitFetchRequest,
  GitFastForwardPreview,
  GitFastForwardRequest,
  GitOperationQuery,
  GitNetworkOperation,
  GitAcquisitionOptions,
  GitAcquisitionPreview,
  GitAcquireRepositoryRequest,
  GitStashSnapshot,
  GitStashPreview,
  GitStashSelection,
  GitStashSaveRequest,
  GitStashApplyRequest,
  GitStashDropRequest,
  GitCompleteOperationPreview,
  GitCompleteOperationRequest,
  GitStashSavePreviewRequest,
  GitStashSavePreview,
  GitConflictSnapshot,
  GitConflictFileRequest,
  GitConflictFile,
  GitBeginConflictRequest,
  GitSaveConflictRequest,
  GitMarkConflictRequest,
  GitIntegrationPreviewRequest,
  GitIntegrationPreview,
  GitStartIntegrationRequest,
  GitIntegrationActionRequest,
  GitIntegrationSnapshot,
  GitHistoryRequest,
  GitHistoryPage,
  GitHistoryDetailRequest,
  GitHistoryDetail,
  GitHistoryFileRequest,
  GitHistoryFile,
  GitHistoryTagOptions,
  GitHistoryTagPreview,
  GitCreateHistoryTagRequest,
  GitHistoryTagQuery,
  GitHistoryTagInfo,
  GitHistoryCandidates,
} from "@lcode/shared";
import { ServiceChannels } from "@lcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { Event } from "@lcode/rpc";
import type {
  GitReviewWorkspaceScope,
  GitReviewWorkspaceSnapshot,
  GitReviewWorkspaceUpdate,
  GitReviewWorkspaceUpdateResult,
  GitCommitReview,
} from "@lcode/shared";

export interface IGitService {
  getHistoryCandidates(params: GitRepositoryRequest): Promise<GitHistoryCandidates>;
  previewHistoryReset(
    params: import("@lcode/shared").GitHistoryResetOptions,
  ): Promise<import("@lcode/shared").GitHistoryResetPreview>;
  previewHistoryResetRecovery(
    params: GitOperationQuery,
  ): Promise<import("@lcode/shared").GitHistoryResetPreview>;
  resetHistory(
    params: import("@lcode/shared").GitHistoryResetRequest,
  ): Promise<GitNetworkOperation>;
  locateHistoryCommit(
    params: import("@lcode/shared").GitHistoryLocateRequest,
  ): Promise<{ hash: string }>;
  getHistory(params: GitHistoryRequest): Promise<GitHistoryPage>;
  getHistoryDetail(params: GitHistoryDetailRequest): Promise<GitHistoryDetail>;
  getHistoryFile(params: GitHistoryFileRequest): Promise<GitHistoryFile>;
  previewHistoryTag(params: GitHistoryTagOptions): Promise<GitHistoryTagPreview>;
  createHistoryTag(params: GitCreateHistoryTagRequest): Promise<GitNetworkOperation>;
  getHistoryTag(params: GitHistoryTagQuery): Promise<GitHistoryTagInfo>;
  getIntegrationSnapshot(params: GitRepositoryRequest): Promise<GitIntegrationSnapshot>;
  previewIntegration(params: GitIntegrationPreviewRequest): Promise<GitIntegrationPreview>;
  startIntegration(params: GitStartIntegrationRequest): Promise<GitNetworkOperation>;
  continueIntegration(params: GitIntegrationActionRequest): Promise<GitNetworkOperation>;
  abortIntegration(params: GitIntegrationActionRequest): Promise<GitNetworkOperation>;
  getConflictSnapshot(params: GitRepositoryRequest): Promise<GitConflictSnapshot>;
  getConflictFile(params: GitConflictFileRequest): Promise<GitConflictFile>;
  beginConflictResolution(params: GitBeginConflictRequest): Promise<GitNetworkOperation>;
  saveConflictResult(params: GitSaveConflictRequest): Promise<GitNetworkOperation>;
  markConflictResolved(params: GitMarkConflictRequest): Promise<GitNetworkOperation>;
  previewRepositoryAcquisition(params: GitAcquisitionOptions): Promise<GitAcquisitionPreview>;
  acquireRepository(params: GitAcquireRepositoryRequest): Promise<GitNetworkOperation>;
  getStashSnapshot(params: GitRepositoryRequest): Promise<GitStashSnapshot>;
  previewStash(params: GitStashSelection): Promise<GitStashPreview>;
  previewStashSave(params: GitStashSavePreviewRequest): Promise<GitStashSavePreview>;
  saveStash(params: GitStashSaveRequest): Promise<GitNetworkOperation>;
  applyStash(params: GitStashApplyRequest): Promise<GitNetworkOperation>;
  dropStash(params: GitStashDropRequest): Promise<GitNetworkOperation>;
  previewGitOperationCompletion(params: GitOperationQuery): Promise<GitCompleteOperationPreview>;
  completeGitOperation(params: GitCompleteOperationRequest): Promise<GitNetworkOperation>;
  getNetworkSnapshot(params: GitRepositoryRequest): Promise<GitNetworkSnapshot>;
  mutateRemote(params: GitRemoteMutationRequest): Promise<GitNetworkOperation>;
  setBranchTracking(params: GitTrackingRequest): Promise<GitNetworkOperation>;
  fetchRemotes(params: GitFetchRequest): Promise<GitNetworkOperation>;
  previewFastForward(params: GitRepositoryRequest): Promise<GitFastForwardPreview>;
  fastForward(params: GitFastForwardRequest): Promise<GitNetworkOperation>;
  getNetworkOperation(params: GitOperationQuery): Promise<GitNetworkOperation | null>;
  getReviewWorkspace(params: GitReviewWorkspaceScope): Promise<GitReviewWorkspaceSnapshot>;
  updateReviewWorkspace(params: GitReviewWorkspaceUpdate): Promise<GitReviewWorkspaceUpdateResult>;
  onDynamicReviewWorkspace(params: GitReviewWorkspaceScope): Event<GitReviewWorkspaceSnapshot>;
  getCommitReview(
    params: GitRepositoryRequest & { reviewId: string },
  ): Promise<{ review: GitCommitReview; position: number } | null>;
  getRepositorySummary(params: GitRepositoryRequest): Promise<GitRepositorySummary>;
  getWorkspaceRepositoryInfo(params: GitRepositoryRequest): Promise<GitWorkspaceRepositoryInfo>;
  getLocalBranches(params: GitRepositoryRequest): Promise<GitLocalBranchListResult>;
  deleteBranch(params: GitDeleteBranchRequest): Promise<GitDeleteBranchResult>;
  getCommitGraph(params: GitCommitGraphRequest): Promise<GitCommitGraphResult>;
  switchBranch(params: GitSwitchBranchRequest): Promise<GitBranchMutationResult>;
  createBranchAndSwitch(params: GitCreateBranchRequest): Promise<GitBranchMutationResult>;
  getChanges(params: GitChangesRequest): Promise<GitFileChange[]>;
  getIgnoredPaths(params: GitIgnoredPathsRequest): Promise<string[]>;
  getDiff(params: GitDiffQuery): Promise<GitDiffResult>;
  getBranchComparison(params: GitRepositoryRequest): Promise<GitBranchComparison>;
  stagePaths(params: GitPathMutationRequest): Promise<void>;
  unstagePaths(params: GitPathMutationRequest): Promise<void>;
  discardPaths(params: GitDiscardPathsRequest): Promise<void>;
  generateCommitMessage(
    params: GitGenerateCommitMessageRequest,
  ): Promise<GitGenerateCommitMessageResult>;
  commit(params: GitCommitRequest): Promise<GitCommitResult>;
  commitAndSwitchBranch(params: GitCommitAndSwitchRequest): Promise<GitCommitAndSwitchResult>;
  push(params: GitPushRequest): Promise<GitPushResult>;
  getPublishState(params: GitPublicationRequest): Promise<GitPublishState>;
  listRemotes(params: GitRepositoryRequest): Promise<GitRemoteListResult>;
  listTags(params: GitRepositoryRequest): Promise<GitTagListResult>;
  createTag(params: GitCreateTagRequest): Promise<GitCreateTagResult>;
  getIdentity(params: GitRepositoryRequest): Promise<GitIdentity>;
  refresh(params: GitRefreshRequest): Promise<GitRefreshResult>;
}

export const IGitService = createServiceDescriptor<IGitService>(ServiceChannels.Git);
