import { lstat, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import semver from "semver";

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** 只回收已由当前运行版本证明安装完成的更新缓存，未来待安装版本仍由 updater 持有。 */
export async function cleanupInstalledUpdateCache(
  directory: string,
  installedVersion: string,
): Promise<void> {
  const current = semver.valid(installedVersion);
  if (!current) return;
  const root = resolve(directory);
  try {
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const version = /^(?:mac|win|linux)-(.+)$/u.exec(entry.name)?.[1];
      if (!entry.isDirectory() || !version || !semver.valid(version)) continue;
      // 旧实现只下载 mac-<version>，从未在新版本启动后回收，导致每次更新永久累积一份 DMG。
      if (semver.gt(version, current)) continue;
      const target = join(root, entry.name);
      if (dirname(target) !== root) continue;
      const info = await lstat(target).catch((error: unknown) => {
        if (isMissing(error)) return undefined;
        throw error;
      });
      if (info?.isDirectory() && !info.isSymbolicLink())
        await rm(target, { recursive: true, force: true });
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}
