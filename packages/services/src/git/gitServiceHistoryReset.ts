import {
  gitHistoryResetOptionsSchema,
  gitHistoryResetPreviewSchema,
  gitHistoryResetRequestSchema,
  gitOperationQuerySchema,
} from "@lcode/shared";
import type { IGitService } from "./git.js";
import { GitHistoryResetRepo } from "./repo/gitHistoryResetRepo.js";
import type { GitHistoryRepo } from "./repo/gitHistoryRepo.js";
export function createGitHistoryResetOperations(
  history: GitHistoryRepo,
): Pick<IGitService, "previewHistoryReset" | "previewHistoryResetRecovery" | "resetHistory"> {
  const repo = new GitHistoryResetRepo(history);
  return {
    async previewHistoryReset(input) {
      return gitHistoryResetPreviewSchema.parse(
        await repo.preview(gitHistoryResetOptionsSchema.parse(input)),
      );
    },
    async previewHistoryResetRecovery(input) {
      return gitHistoryResetPreviewSchema.parse(
        await repo.recovery(gitOperationQuerySchema.parse(input)),
      );
    },
    async resetHistory(input) {
      const params = gitHistoryResetRequestSchema.parse(input);
      return history.safety.journal.run(
        params.preview.recovery ? "history-reset-restore" : "history-reset",
        params,
        (checkpoint) => repo.execute(params, checkpoint),
      );
    },
  };
}
