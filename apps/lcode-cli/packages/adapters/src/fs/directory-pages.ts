import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { createFileSystemError, type FileSystemListDirectoryEntry } from "@lcode/contracts";

/** 遍历目录只保留最小一页名称；不依赖 opendir 的不稳定枚举顺序。 */
export async function listDirectoryPage(input: {
  path: string;
  limit: number;
  page: { afterName?: string; revision?: string };
  signal?: AbortSignal;
}) {
  const before = await lstat(input.path);
  if (!before.isDirectory() || before.isSymbolicLink())
    throw createFileSystemError({
      code: "invalid_path",
      message: "Directory page requires a regular directory",
    });
  const revision = [before.dev, before.ino, before.mtimeMs, before.ctimeMs].join(":");
  if (input.page.revision && input.page.revision !== revision)
    throw createFileSystemError({
      code: "stale_write",
      message: "Directory changed between pages",
    });
  const entries: FileSystemListDirectoryEntry[] = [];
  let eligible = 0;
  const directory = await opendir(input.path, { bufferSize: 32 });
  for await (const entry of directory) {
    input.signal?.throwIfAborted();
    if (input.page.afterName !== undefined && entry.name <= input.page.afterName) continue;
    eligible++;
    const next = {
      name: entry.name,
      path: join(input.path, entry.name),
      kind: entry.isSymbolicLink()
        ? "symlink"
        : entry.isFile()
          ? "file"
          : entry.isDirectory()
            ? "directory"
            : "other",
    } as FileSystemListDirectoryEntry;
    const index = entries.findIndex((current) => current.name > next.name);
    if (index < 0) {
      if (entries.length < input.limit) entries.push(next);
    } else {
      entries.splice(index, 0, next);
      if (entries.length > input.limit) entries.pop();
    }
  }
  const after = await lstat(input.path);
  if ([after.dev, after.ino, after.mtimeMs, after.ctimeMs].join(":") !== revision)
    throw createFileSystemError({
      code: "stale_write",
      message: "Directory changed while reading a page",
    });
  const truncated = eligible > entries.length;
  return {
    entries,
    truncated,
    ...(truncated ? { nextPage: { afterName: entries.at(-1)!.name, revision } } : {}),
  };
}
