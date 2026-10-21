import {
  gitRepositoryRequestSchema,
  gitNetworkSnapshotSchema,
  gitFastForwardPreviewSchema,
  gitRemoteMutationRequestSchema,
  gitTrackingRequestSchema,
  gitFetchRequestSchema,
  gitFastForwardRequestSchema,
  gitOperationQuerySchema,
} from "@lcode/shared";
import type { IGitService } from "./git.js";
import type { GitCliRepo } from "./repo/gitCliTypes.js";
import type { GitCommandProvider } from "./providers/gitCommandProvider.js";
import { GitNetworkRepo } from "./repo/gitNetworkRepo.js";
import { GitFastForwardRepo } from "./repo/gitFastForwardRepo.js";
import { GitNetworkJournal } from "./gitNetworkJournal.js";

export function createGitNetworkOperations(
  repo: GitCliRepo,
  command: GitCommandProvider,
  dataDir?: string,
  journal = new GitNetworkJournal(dataDir),
): Pick<
  IGitService,
  | "getNetworkSnapshot"
  | "mutateRemote"
  | "setBranchTracking"
  | "fetchRemotes"
  | "previewFastForward"
  | "fastForward"
  | "getNetworkOperation"
> {
  const network = new GitNetworkRepo(repo, command);
  const update = new GitFastForwardRepo(repo, command, network.state, (path) =>
    network.snapshot(path),
  );
  return {
    getNetworkSnapshot: async (input) =>
      gitNetworkSnapshotSchema.parse(
        await network.snapshot(gitRepositoryRequestSchema.parse(input).workspacePath),
      ),
    previewFastForward: async (input) =>
      gitFastForwardPreviewSchema.parse(
        await update.preview(gitRepositoryRequestSchema.parse(input).workspacePath),
      ),
    getNetworkOperation: (input) => journal.get(gitOperationQuerySchema.parse(input)),
    async mutateRemote(input) {
      const params = gitRemoteMutationRequestSchema.parse(input);
      return journal.run("remote", params, () => network.remote(params));
    },
    async setBranchTracking(input) {
      const params = gitTrackingRequestSchema.parse(input);
      return journal.run("tracking", params, () => network.tracking(params));
    },
    async fetchRemotes(input) {
      const params = gitFetchRequestSchema.parse(input);
      return journal.run("fetch", params, (checkpoint) => network.fetch(params, checkpoint));
    },
    async fastForward(input) {
      const params = gitFastForwardRequestSchema.parse(input);
      return journal.run("fast-forward", params, () => update.fastForward(params));
    },
  };
}
