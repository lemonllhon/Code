import type { GitBackupDestinationResult } from "./gitBackup.js";
import "./gitBackupOssClient.js";
import "./gitBackupMinioClient.js";

export function backupDestinationFailure(results: GitBackupDestinationResult[]): Error {
  const failed = results.filter((result) => !result.ok);
  return Object.assign(
    new Error(
      `Git backup destination(s) failed: ${failed.map((result) => `${result.provider}: ${result.error}`).join("; ")}`,
    ),
    { code: "GIT_BACKUP_DESTINATION_FAILED", details: { destinations: results } },
  );
}
