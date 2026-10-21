import { gitDiscardPathsRequestSchema, gitPathMutationRequestSchema } from "@lcode/shared";
import type { IGitService } from "./git.js";
import type { GitCliRepo } from "./repo/gitCliTypes.js";
import type { GitPublishStateReader } from "./repo/gitPublishState.js";

export function createGitFileOperations(
  repo: GitCliRepo,
  state: GitPublishStateReader,
): Pick<IGitService, "stagePaths" | "unstagePaths" | "discardPaths"> {
  return {
    async stagePaths(input) {
      const params = gitPathMutationRequestSchema.parse(input);
      if (params.expectedState)
        await state.assertCurrent(params.workspacePath, params.expectedState);
      await repo.stage(params.workspacePath, params.paths);
    },
    async unstagePaths(input) {
      const params = gitPathMutationRequestSchema.parse(input);
      if (params.expectedState)
        await state.assertCurrent(params.workspacePath, params.expectedState);
      await repo.unstage(params.workspacePath, params.paths);
    },
    async discardPaths(input) {
      const params = gitDiscardPathsRequestSchema.parse(input);
      await state.assertCurrent(params.workspacePath, params.expectedState);
      await repo.discard(params.workspacePath, params.paths, params.staged ?? false);
    },
  };
}
