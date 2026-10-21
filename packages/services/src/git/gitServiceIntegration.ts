import {
  gitRepositoryRequestSchema,
  gitIntegrationPreviewRequestSchema,
  gitIntegrationPreviewSchema,
  gitStartIntegrationRequestSchema,
  gitIntegrationActionRequestSchema,
  gitIntegrationSnapshotSchema,
} from "@lcode/shared";
import type { IGitService } from "./git.js";
import type { GitWorkspaceSafety } from "./repo/gitWorkspaceSafety.js";
import { GitIntegrationRepo } from "./repo/gitIntegrationRepo.js";
import { GitIntegrationMutations } from "./repo/gitIntegrationMutations.js";

export function createGitIntegrationOperations(
  safety: GitWorkspaceSafety,
): Pick<
  IGitService,
  | "getIntegrationSnapshot"
  | "previewIntegration"
  | "startIntegration"
  | "continueIntegration"
  | "abortIntegration"
> {
  const repo = new GitIntegrationRepo(safety),
    mutations = new GitIntegrationMutations(repo);
  return {
    async getIntegrationSnapshot(input) {
      return gitIntegrationSnapshotSchema.parse(
        await repo.snapshot(gitRepositoryRequestSchema.parse(input)),
      );
    },
    async previewIntegration(input) {
      return gitIntegrationPreviewSchema.parse(
        await repo.preview(gitIntegrationPreviewRequestSchema.parse(input)),
      );
    },
    async startIntegration(input) {
      const params = gitStartIntegrationRequestSchema.parse(input);
      return safety.journal.run(params.preview.mode, params, (checkpoint) =>
        mutations.start(params, checkpoint),
      );
    },
    async continueIntegration(input) {
      const params = gitIntegrationActionRequestSchema.parse(input);
      return safety.journal.run("integration-continue", params, (checkpoint) =>
        mutations.action(params, false, checkpoint),
      );
    },
    async abortIntegration(input) {
      const params = gitIntegrationActionRequestSchema.parse(input);
      return safety.journal.run("integration-abort", params, (checkpoint) =>
        mutations.action(params, true, checkpoint),
      );
    },
  };
}
