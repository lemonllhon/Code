import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "@lcode/shared/node";
import type { BackupEngineState } from "../app/ports.js";
import { validateBackupPolicy } from "../domain/backupRules.js";
export function createBackupStateStore(dataDir: string) {
  const file = join(dataDir, "backup-lifecycle.json");
  return async function state<T>(
    operation: (state: BackupEngineState) => T | Promise<T>,
  ): Promise<T> {
    return withFileLock(file, async () => {
      let state: BackupEngineState;
      let before: string | null = null;
      try {
        before = await readFile(file, "utf8");
        state = JSON.parse(before);
        if (
          state.version !== 1 ||
          typeof state.sourceId !== "string" ||
          !state.checkpoints ||
          !state.operations
        )
          throw new Error("Invalid backup lifecycle state");
        validateBackupPolicy(state.policy);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        state = {
          version: 1,
          sourceId: randomUUID(),
          policy: {
            revision: 0,
            localEnabled: false,
            localDirectory: null,
            retention: { local: 10, oss: 10, minio: 10 },
            providers: {
              enabled: false,
              intervalMinutes: 60,
              selection: null,
              locations: ["local"],
            },
          },
          nextProviderAt: null,
          lastCheckAt: null,
          lastResult: null,
          error: null,
          checkpoints: {},
          operations: {},
        };
      }
      const result = await operation(state);
      const after = JSON.stringify(state);
      if (after !== before) await atomicWritePrivateTextFile(file, after);
      return result;
    });
  };
}
