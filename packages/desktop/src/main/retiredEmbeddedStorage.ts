import { lstat, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const RETIRED_PARTITION_NAMES = ["zcode-coding-plan", "lcode-coding-plan"] as const;

/** 仅清理当前 LCode 的购买页分区；API Key 和其他浏览器分区不属于此目录。 */
export async function removeRetiredEmbeddedStorage(options: {
  userDataPath: string;
  sessionDataPath: string;
  onError: (path: string, error: unknown) => void;
}): Promise<void> {
  const roots = new Set([
    resolve(options.sessionDataPath, "Partitions"),
    resolve(options.userDataPath, "Partitions"),
    resolve(options.userDataPath, "session", "Partitions"),
  ]);
  const legacyTelemetry = resolve(options.userDataPath, "zcode-data-size-telemetry.json");
  try {
    await rm(legacyTelemetry, { force: true });
  } catch (error) {
    options.onError(legacyTelemetry, error);
  }
  for (const root of roots) {
    for (const name of RETIRED_PARTITION_NAMES) {
      const target = resolve(join(root, name));
      const child = relative(root, target);
      if (!child || child.startsWith(`..${sep}`) || child.includes(sep)) continue;
      try {
        // 不跟随符号链接；只移除精确命名的旧分区，避免影响目录外的用户数据。
        const entry = await lstat(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!entry) continue;
        await rm(target, {
          recursive: entry.isDirectory() && !entry.isSymbolicLink(),
          force: true,
        });
      } catch (error) {
        options.onError(target, error);
      }
    }
  }
}
