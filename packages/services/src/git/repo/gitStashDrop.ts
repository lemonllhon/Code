import { lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { GitStashDropRequest } from "@lcode/shared";
import { GitNetworkError } from "../gitNetworkJournal.js";
import type { GitStashRepo } from "./gitStashRepo.js";
import type { GitOperationEffect } from "./gitWorkspaceSafety.js";

/** 原生 stash drop 只接受可移动的 selector；这里在 Git 原生文件锁内比较 bytes/OID 后精确发布。 */
export async function dropSelectedStash(
  repo: GitStashRepo,
  params: GitStashDropRequest,
): Promise<GitOperationEffect> {
  const records = await repo.selection(params);
  if (!records.entries.some((item) => item.oid === params.oid && item.selector === params.selector))
    throw new GitNetworkError("stale-preview");
  const { safety } = repo;
  const cwd = records.cwd;
  const storage = (
    await safety.git(cwd, ["config", "--get", "extensions.refStorage"], [0, 1])
  ).trim();
  if (storage && storage !== "files") throw new GitNetworkError("unsupported-stash-storage");
  const path = async (name: string) =>
    resolve(cwd, (await safety.git(cwd, ["rev-parse", "--git-path", name])).trim());
  const common = await realpath(
    (await safety.git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim(),
  );
  const refPath = await path("refs/stash"),
    packedPath = await path("packed-refs");
  for (const file of [refPath, packedPath, records.logPath]) {
    const local = relative(common, await realpath(dirname(file)));
    if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`))
      throw new GitNetworkError("unsupported-stash-storage");
    const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (info && (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 ** 2))
      throw new GitNetworkError("unsupported-stash-storage");
  }
  const handles = new Map<string, Awaited<ReturnType<typeof open>>>();
  const owned = new Set<string>();
  let publishing = false;
  try {
    for (const file of [packedPath, refPath, records.logPath]) {
      const lock = `${file}.lock`;
      handles.set(lock, await open(lock, "wx", 0o600));
      owned.add(lock);
    }
    const packed = await readFile(packedPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return "";
    });
    if (/^[a-f0-9]+ refs\/stash$/m.test(packed))
      throw new GitNetworkError("unsupported-stash-storage");
    const raw = await readFile(records.logPath);
    const ref = (await readFile(refPath, "utf8")).trim();
    if (!raw.equals(records.log) || ref !== records.head)
      throw new GitNetworkError("stale-preview");
    const lines = raw.toString("binary").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const index = lines.length - 1 - Number(/^stash@\{(\d+)\}$/.exec(params.selector)![1]);
    const parsed = lines.map((line) =>
      /^([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) (.+)$/.exec(line),
    );
    if (
      parsed.some((item) => !item) ||
      lines.length !== records.entries.length ||
      parsed[index]?.[2] !== params.oid
    )
      throw new GitNetworkError("stale-preview");
    parsed.splice(index, 1);
    let old = "0".repeat(ref.length);
    const rewritten = parsed
      .map((entry) => {
        const line = `${old} ${entry![2]} ${entry![3]}\n`;
        old = entry![2]!;
        return line;
      })
      .join("");
    if (parsed.length) await safety.git(cwd, ["cat-file", "-e", `${old}^{commit}`]);
    for (const [file, bytes] of [
      [records.logPath, Buffer.from(rewritten, "binary")],
      [refPath, Buffer.from(`${old}\n`)],
    ] as const) {
      const handle = handles.get(`${file}.lock`)!;
      await handle.writeFile(bytes);
      await handle.sync();
    }
    for (const handle of handles.values()) await handle.close();
    handles.clear();
    publishing = true;
    if (parsed.length) {
      await rename(`${records.logPath}.lock`, records.logPath);
      owned.delete(`${records.logPath}.lock`);
      await rename(`${refPath}.lock`, refPath);
      owned.delete(`${refPath}.lock`);
    } else {
      await unlink(records.logPath);
      await unlink(refPath);
    }
    return { status: "success", stashOid: params.oid };
  } catch (error) {
    if (publishing)
      return { status: "unknown", stashOid: params.oid, code: "stash-delete-incomplete" };
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new GitNetworkError("git-lock-busy");
    throw error;
  } finally {
    for (const handle of handles.values()) await handle.close().catch(() => {});
    for (const lock of owned)
      await unlink(lock).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    safety.repo.invalidate(params.workspacePath);
  }
}
