import {
  getGitBackupDestinationLocation,
  type GitBackupManifest,
  type GitBackupWorkspaceTarget,
  type GitBackupDestinationResult,
} from "./gitBackup.js";
import {
  createBackupStore,
  EMPTY_BACKUP_DESTINATION_STATE,
  type GitBackupAdmission,
} from "./gitBackupStore.js";
import { backupDestinationFailure } from "./gitBackupDestinations.js";
export function createGitBackupResultRecorder(store: ReturnType<typeof createBackupStore>) {
  async function recordResults(
    admission: GitBackupAdmission,
    target: GitBackupWorkspaceTarget,
    attemptedAt: string,
    results: GitBackupDestinationResult[],
    manifest?: GitBackupManifest,
    localResult?: { status: string; error?: string },
  ) {
    await store.updateState((state, current) => {
      const destinations = { ...state.destinations };
      // 旧地址的成功和失败都不能污染替换配置，独立与全局结果必须使用同一过滤条件。
      const currentResults = results.filter(
        (result) =>
          getGitBackupDestinationLocation(admission.config[result.provider]) ===
          getGitBackupDestinationLocation(current[result.provider]),
      );
      const sameLocations = currentResults.length === results.length;
      for (const result of currentResults) {
        const provider = result.provider;
        const previous = destinations[provider] ?? { ...EMPTY_BACKUP_DESTINATION_STATE };
        destinations[provider] = {
          ...previous,
          lastAttemptAt: attemptedAt,
          ...(result.ok && manifest && !result.skipped
            ? {
                lastBackupAt: manifest.createdAt,
                lastBackupFiles: manifest.totalFiles,
                lastBackupSize: manifest.totalSize,
                lastWorkspacePath: target.workspacePath,
              }
            : {}),
          error: result.ok ? null : (result.error ?? "Git backup failed"),
        };
      }
      const successful =
        results.every((result) => result.ok) &&
        (!localResult || localResult.status !== "failed") &&
        (results.some((result) => !result.skipped) || localResult?.status === "created") &&
        manifest &&
        sameLocations;
      return {
        ...state,
        running: false,
        destinations,
        ...(successful
          ? {
              lastBackupAt: manifest.createdAt,
              lastBackupFiles: manifest.totalFiles,
              lastBackupSize: manifest.totalSize,
              lastWorkspacePath: target.workspacePath,
              lastBackupProviders: results.map((result) => result.provider),
            }
          : {}),
        ...(currentResults.length
          ? {
              error: currentResults.some((result) => !result.ok)
                ? backupDestinationFailure(currentResults).message
                : null,
              errorProviders: currentResults
                .filter((result) => !result.ok)
                .map((result) => result.provider),
            }
          : {}),
        ...(localResult?.status === "failed"
          ? { error: localResult.error || "Local backup failed" }
          : {}),
      };
    });
  }

  return recordResults;
}
