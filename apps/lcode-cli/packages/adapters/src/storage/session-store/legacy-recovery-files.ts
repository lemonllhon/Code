import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sanitizePathSegment } from "../artifact-codecs.js";

async function ensureDirectory(path: string): Promise<void> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info) {
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Legacy recovery destination is not a regular directory");
    return;
  }
  await ensureDirectory(dirname(path));
  await mkdir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const created = await lstat(path);
  if (!created.isDirectory() || created.isSymbolicLink())
    throw new Error("Legacy recovery destination changed");
}

async function copyMissingTree(source: string, target: string): Promise<void> {
  const info = await lstat(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await ensureDirectory(target);
    for (const entry of await readdir(source))
      await copyMissingTree(join(source, entry), join(target, entry));
  } else if (info.isFile()) {
    await ensureDirectory(dirname(target));
    // COPYFILE_EXCL 原子保留当前文件，包括并发 writer 刚刚发布的文件。
    await copyFile(source, target, constants.COPYFILE_EXCL).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
  }
}

export async function copyLegacySessionFiles(
  sourceDb: string,
  targetDb: string,
  sessionIds: readonly string[],
): Promise<void> {
  const sourceCli = dirname(dirname(sourceDb));
  const targetCli = dirname(dirname(targetDb));
  for (const name of ["artifacts", "agents"]) {
    const source = join(sourceCli, name);
    const info = await lstat(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info || info.isSymbolicLink()) continue;
    for (const id of sessionIds) {
      const segment = sanitizePathSegment(id);
      if (segment === "." || segment === "..")
        throw new Error("Invalid legacy session artifact segment");
      await copyMissingTree(join(source, segment), join(targetCli, name, segment));
    }
  }
}
