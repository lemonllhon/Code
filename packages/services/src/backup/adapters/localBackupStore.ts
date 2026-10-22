import { lstat, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { atomicWritePrivateTextFile } from "@lcode/shared/node";
import type { BackupObjectStore } from "../app/ports.js";
export function localBackupStore(directory: string): BackupObjectStore {
  if (!isAbsolute(directory)) throw new Error("Backup directory must be absolute");
  const root = resolve(directory);
  async function path(key: string, create = false) {
    if (
      !/^lcode-backup\/v2\/[A-Za-z0-9/_-]+\.(json|deleted)$/.test(key) ||
      key.split("/").includes("..")
    )
      throw new Error("Invalid backup object key");
    const target = resolve(root, ...key.split("/"));
    if (relative(root, target).startsWith("..") || target === root)
      throw new Error("Backup path escapes its directory");
    let current = root;
    for (const part of ["", ...relative(root, target).split(/[\\/]/)]) {
      if (part) current = join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink())
          throw new Error("Backup paths must not contain symbolic links");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (create) {
      await mkdir(dirname(target), { recursive: true });
      await path(key);
    }
    return target;
  }
  return {
    location: "local",
    revision: root,
    async put(key, data) {
      await atomicWritePrivateTextFile(await path(key, true), Buffer.from(data).toString("utf8"));
    },
    async get(key) {
      try {
        return await readFile(await path(key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async remove(key) {
      try {
        await unlink(await path(key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
    async exists(key) {
      try {
        return (await lstat(await path(key))).isFile();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    async list(prefix) {
      if (prefix !== "lcode-backup/v2/") throw new Error("Invalid backup prefix");
      const result: string[] = [];
      async function walk(dir: string) {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        for (const entry of entries) {
          if (entry.isSymbolicLink())
            throw new Error("Backup paths must not contain symbolic links");
          const full = join(dir, entry.name);
          if (entry.isDirectory()) await walk(full);
          else if (entry.isFile()) result.push(relative(root, full).replaceAll("\\", "/"));
          if (result.length > 100_000)
            throw new Error("Backup catalog is too large; narrow the location prefix");
        }
      }
      await path("lcode-backup/v2/check.json");
      await walk(join(root, "lcode-backup", "v2"));
      return result;
    },
  };
}
