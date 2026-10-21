import {
  gitRepositoryRequestSchema,
  gitAcquisitionOptionsSchema,
  gitAcquisitionPreviewSchema,
  gitAcquireRepositoryRequestSchema,
  gitStashSnapshotSchema,
  gitStashPreviewSchema,
  gitStashSelectionSchema,
  gitStashSaveRequestSchema,
  gitStashSavePreviewRequestSchema,
  gitStashSavePreviewSchema,
  gitStashApplyRequestSchema,
  gitStashDropRequestSchema,
  gitOperationQuerySchema,
  gitCompleteOperationRequestSchema,
  gitCompleteOperationPreviewSchema,
} from "@lcode/shared";
import type { CheckoutCoordinator } from "../worktree/node.js";
import type { IGitService } from "./git.js";
import type { GitCommandProvider } from "./providers/gitCommandProvider.js";
import type { GitCliRepo } from "./repo/gitCliTypes.js";
import type { GitNetworkJournal } from "./gitNetworkJournal.js";
import { GitWorkspaceSafety } from "./repo/gitWorkspaceSafety.js";
import { GitAcquisitionRepo } from "./repo/gitAcquisitionRepo.js";
import { GitStashRepo } from "./repo/gitStashRepo.js";
import { GitStashMutations } from "./repo/gitStashMutations.js";
import { dropSelectedStash } from "./repo/gitStashDrop.js";
import { createGitConflictOperations } from "./gitServiceConflicts.js";
import { createGitIntegrationOperations } from "./gitServiceIntegration.js";
import { createGitHistoryOperations } from "./gitServiceHistory.js";

export function createGitWorkspaceOperations(
  repo: GitCliRepo,
  command: GitCommandProvider,
  journal: GitNetworkJournal,
  coordinator?: CheckoutCoordinator,
): Pick<
  IGitService,
  | "previewRepositoryAcquisition"
  | "acquireRepository"
  | "getStashSnapshot"
  | "previewStash"
  | "previewStashSave"
  | "saveStash"
  | "applyStash"
  | "dropStash"
  | "previewGitOperationCompletion"
  | "completeGitOperation"
  | "getConflictSnapshot"
  | "getConflictFile"
  | "beginConflictResolution"
  | "saveConflictResult"
  | "markConflictResolved"
  | "getIntegrationSnapshot"
  | "previewIntegration"
  | "startIntegration"
  | "continueIntegration"
  | "abortIntegration"
  | "getHistory"
  | "getHistoryCandidates"
  | "locateHistoryCommit"
  | "previewHistoryReset"
  | "previewHistoryResetRecovery"
  | "resetHistory"
  | "getHistoryDetail"
  | "getHistoryFile"
  | "previewHistoryTag"
  | "createHistoryTag"
  | "getHistoryTag"
> {
  const safety = new GitWorkspaceSafety(repo, command, journal, coordinator);
  const acquisition = new GitAcquisitionRepo(safety),
    stash = new GitStashRepo(safety),
    mutations = new GitStashMutations(stash);
  return {
    ...createGitConflictOperations(safety),
    ...createGitIntegrationOperations(safety),
    ...createGitHistoryOperations(safety),
    async previewRepositoryAcquisition(input) {
      return gitAcquisitionPreviewSchema.parse(
        await acquisition.preview(gitAcquisitionOptionsSchema.parse(input)),
      );
    },
    async acquireRepository(input) {
      const params = gitAcquireRepositoryRequestSchema.parse(input);
      const command = { ...params.options, requestId: params.requestId, preview: params.preview };
      return journal.run(
        params.options.mode === "init" ? "repository-init" : "repository-clone",
        command,
        (checkpoint) => acquisition.acquire(params, checkpoint),
      );
    },
    async getStashSnapshot(input) {
      return gitStashSnapshotSchema.parse(
        await stash.snapshot(gitRepositoryRequestSchema.parse(input)),
      );
    },
    async previewStash(input) {
      return gitStashPreviewSchema.parse(await stash.preview(gitStashSelectionSchema.parse(input)));
    },
    async previewStashSave(input) {
      return gitStashSavePreviewSchema.parse(
        await stash.previewSave(gitStashSavePreviewRequestSchema.parse(input)),
      );
    },
    async saveStash(input) {
      const params = gitStashSaveRequestSchema.parse(input);
      return journal.run("stash-save", params, (checkpoint) => mutations.save(params, checkpoint));
    },
    async applyStash(input) {
      const params = gitStashApplyRequestSchema.parse(input);
      return journal.run("stash-apply", params, (checkpoint) =>
        mutations.apply(params, checkpoint),
      );
    },
    async dropStash(input) {
      const params = gitStashDropRequestSchema.parse(input);
      return journal.run("stash-drop", params, () => dropSelectedStash(stash, params));
    },
    async previewGitOperationCompletion(input) {
      return gitCompleteOperationPreviewSchema.parse(
        await safety.completionPreview(gitOperationQuerySchema.parse(input)),
      );
    },
    async completeGitOperation(input) {
      const params = gitCompleteOperationRequestSchema.parse(input);
      return journal.run("reconcile", params, (checkpoint) => safety.complete(params, checkpoint));
    },
  };
}
