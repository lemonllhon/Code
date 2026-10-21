import {
  gitRepositoryRequestSchema,
  gitConflictSnapshotSchema,
  gitConflictFileSchema,
  gitConflictFileRequestSchema,
  gitBeginConflictRequestSchema,
  gitSaveConflictRequestSchema,
  gitMarkConflictRequestSchema,
} from "@lcode/shared";
import type { IGitService } from "./git.js";
import { GitConflictRepo } from "./repo/gitConflictRepo.js";
import { GitConflictMutations } from "./repo/gitConflictMutations.js";
import { GitWorkspaceSafety } from "./repo/gitWorkspaceSafety.js";

export function createGitConflictOperations(
  safety: GitWorkspaceSafety,
): Pick<
  IGitService,
  | "getConflictSnapshot"
  | "getConflictFile"
  | "beginConflictResolution"
  | "saveConflictResult"
  | "markConflictResolved"
> {
  const repo = new GitConflictRepo(safety),
    mutations = new GitConflictMutations(repo);
  return {
    async getConflictSnapshot(input) {
      return gitConflictSnapshotSchema.parse(
        (await repo.records(gitRepositoryRequestSchema.parse(input))).snapshot,
      );
    },
    async getConflictFile(input) {
      return gitConflictFileSchema.parse(
        (await repo.file(gitConflictFileRequestSchema.parse(input))).detail,
      );
    },
    async beginConflictResolution(input) {
      const params = gitBeginConflictRequestSchema.parse(input);
      return safety.journal.run("conflict-resolution", params, (checkpoint) =>
        mutations.begin(params, checkpoint),
      );
    },
    async saveConflictResult(input) {
      const params = gitSaveConflictRequestSchema.parse(input);
      return safety.journal.run("conflict-save", params, (checkpoint) =>
        mutations.save(params, checkpoint),
      );
    },
    async markConflictResolved(input) {
      const params = gitMarkConflictRequestSchema.parse(input);
      return safety.journal.run("conflict-mark", params, (checkpoint) =>
        mutations.mark(params, checkpoint),
      );
    },
  };
}
