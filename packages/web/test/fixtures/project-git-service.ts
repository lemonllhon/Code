import type { GitNetworkOperation } from "@lcode/shared";
export function createProjectGitFixture(calls: Array<{ method: string; params: unknown }>) {
  const receipts = new Map<string, GitNetworkOperation>();
  return {
    getNetworkOperation: async ({ requestId }: { requestId: string }) =>
      receipts.get(requestId) ?? null,
    previewRepositoryAcquisition: async (options: any) => {
      calls.push({ method: "importPreview", params: options });
      return {
        revision: "a".repeat(64),
        mode: options.mode,
        targetPath:
          options.mode === "init"
            ? options.workspacePath
            : `${options.workspacePath}/${options.targetName}`,
        parentRepository: null,
      };
    },
    acquireRepository: async (request: any) => {
      calls.push({ method: "acquireRepository", params: request });
      const receipt: GitNetworkOperation = {
        requestId: request.requestId,
        kind: request.options.mode === "init" ? "repository-init" : "repository-clone",
        status: "success",
        targetPath: request.preview.targetPath,
        startedAt: "2026-10-21T00:00:00.000Z",
      };
      receipts.set(receipt.requestId, receipt);
      return receipt;
    },
  };
}
