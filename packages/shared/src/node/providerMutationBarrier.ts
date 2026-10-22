import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, join, resolve } from "node:path";
import { withFileLock } from "./privateFilePersistence.js";
import { access } from "node:fs/promises";
const context = new AsyncLocalStorage<{ path: string; active: boolean }>();
/** 供应商恢复跨配置和账号提交时，各进程的普通读写都必须经过同一屏障。 */
export async function withProviderMutationBarrier<T>(
  fileInProfile: string,
  operation: () => Promise<T>,
  allowRecovery = false,
): Promise<T> {
  const path = join(dirname(resolve(fileInProfile)), "provider-mutation-barrier");
  const held = context.getStore();
  if (held?.active && held.path === path) return operation();
  return withFileLock(path, async () => {
    if (!allowRecovery) {
      let unfinished = true;
      try {
        await access(join(dirname(path), "provider-backup-restore.json"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") unfinished = false;
        else throw error;
      }
      if (unfinished)
        throw new Error(
          "Unfinished provider restore requires recovery before reading or editing configuration",
        );
    }
    const owner = { path, active: true };
    try {
      return await context.run(owner, operation);
    } finally {
      owner.active = false;
    }
  });
}
