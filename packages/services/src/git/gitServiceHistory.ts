import {
  gitHistoryRequestSchema,
  gitHistoryPageSchema,
  gitHistoryDetailRequestSchema,
  gitHistoryDetailSchema,
  gitHistoryFileRequestSchema,
  gitHistoryFileSchema,
  gitHistoryTagOptionsSchema,
  gitHistoryTagPreviewSchema,
  gitCreateHistoryTagRequestSchema,
  gitHistoryTagQuerySchema,
  gitHistoryTagInfoSchema,
  gitHistoryCandidatesSchema,
  gitRepositoryRequestSchema,
  gitHistoryLocateRequestSchema,
  gitHistoryLocateResultSchema,
} from "@lcode/shared";
import type { IGitService } from "./git.js";
import type { GitWorkspaceSafety } from "./repo/gitWorkspaceSafety.js";
import { GitHistoryRepo } from "./repo/gitHistoryRepo.js";
import { GitHistoryTagRepo } from "./repo/gitHistoryTagRepo.js";
import { GitHistoryCandidatesRepo } from "./repo/gitHistoryCandidatesRepo.js";
import { GitHistorySearch } from "./repo/gitHistorySearch.js";
import { createGitHistoryResetOperations } from "./gitServiceHistoryReset.js";

export function createGitHistoryOperations(
  safety: GitWorkspaceSafety,
): Pick<
  IGitService,
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
  const history = new GitHistoryRepo(safety),
    tags = new GitHistoryTagRepo(history);
  return {
    ...createGitHistoryResetOperations(history),
    async locateHistoryCommit(input) {
      return gitHistoryLocateResultSchema.parse(
        await new GitHistorySearch(history).locate(gitHistoryLocateRequestSchema.parse(input)),
      );
    },
    async getHistoryCandidates(input) {
      return gitHistoryCandidatesSchema.parse(
        await new GitHistoryCandidatesRepo(history).read(gitRepositoryRequestSchema.parse(input)),
      );
    },
    async getHistory(input) {
      return gitHistoryPageSchema.parse(await history.page(gitHistoryRequestSchema.parse(input)));
    },
    async getHistoryDetail(input) {
      return gitHistoryDetailSchema.parse(
        await history.detail(gitHistoryDetailRequestSchema.parse(input)),
      );
    },
    async getHistoryFile(input) {
      return gitHistoryFileSchema.parse(
        await history.file(gitHistoryFileRequestSchema.parse(input)),
      );
    },
    async previewHistoryTag(input) {
      return gitHistoryTagPreviewSchema.parse(
        await tags.preview(gitHistoryTagOptionsSchema.parse(input)),
      );
    },
    async getHistoryTag(input) {
      return gitHistoryTagInfoSchema.parse(
        await tags.inspect(gitHistoryTagQuerySchema.parse(input)),
      );
    },
    async createHistoryTag(input) {
      const params = gitCreateHistoryTagRequestSchema.parse(input);
      return safety.journal.run("history-tag", params, (checkpoint) =>
        tags.create(params, checkpoint),
      );
    },
  };
}
