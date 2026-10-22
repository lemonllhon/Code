import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { BackupSourcePort } from "../backup/node.js";
import type { BackupRestoreRequest, BackupSnapshot, BackupTarget } from "../backup/contract.js";
import { createGitCommandProvider, type GitCommandProvider } from "../git/node.js";
import { captureGitSnapshot, type GitBackupSnapshotOptions } from "./gitBackupSnapshot.js";
import { gitBackupWorkspaceKey } from "./gitBackup.js";
const fileSchema = z
  .object({
    path: z.string().min(1),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mode: z.number().int().min(0).max(0o777).optional(),
    content: z.string(),
  })
  .strict();
const gitDataSchema = z
  .object({
    version: z.literal(1),
    target: z
      .object({ workspacePath: z.string(), workspaceIdentity: z.string().optional() })
      .strict(),
    files: z.array(fileSchema).max(100_000),
  })
  .strict();
export function unpackGitBackup(packed: Buffer) {
  const files: { path: string; content: Buffer }[] = [];
  let cursor = 0;
  while (cursor < packed.length) {
    const pathEnd = packed.indexOf(0, cursor);
    const sizeEnd = packed.indexOf(0, pathEnd + 1);
    if (pathEnd < cursor || sizeEnd < pathEnd || sizeEnd - pathEnd > 20)
      throw new Error("Invalid legacy Git archive header");
    const path = packed.subarray(cursor, pathEnd).toString("utf8");
    const sizeText = packed.subarray(pathEnd + 1, sizeEnd).toString("ascii");
    const size = Number(sizeText);
    if (
      !/^\d+$/.test(sizeText) ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      sizeEnd + 1 + size > packed.length
    )
      throw new Error("Invalid Git archive length");
    files.push({ path, content: packed.subarray(sizeEnd + 1, sizeEnd + 1 + size) });
    cursor = sizeEnd + 1 + size;
    if (files.length > 100_000) throw new Error("Git archive has too many files");
  }
  return files;
}
function checkedData(snapshot: BackupSnapshot) {
  const data = gitDataSchema.parse(snapshot.data);
  const paths = new Set<string>();
  let size = 0;
  for (const file of data.files) {
    const path = file.path.replaceAll("\\", "/");
    const parts = path.split("/");
    if (
      parts[0] === "worktrees" ||
      parts.includes("commondir") ||
      ["objects/info/alternates", "objects/info/http-alternates"].includes(path) ||
      path.endsWith(".lock") ||
      path.endsWith(".promisor")
    )
      throw new Error("Git archive requires external repository data or an active lock");
    if (
      path.startsWith("/") ||
      path.includes(":") ||
      Array.from(path).some((char) => char.charCodeAt(0) < 32) ||
      parts.some(
        (x) =>
          !x ||
          x === "." ||
          x === ".." ||
          /[. ]$/.test(x) ||
          /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(x),
      )
    )
      throw new Error("Unsafe Git archive path");
    const folded = path.toLocaleLowerCase("en-US");
    if (paths.has(folded)) throw new Error("Duplicate or case-conflicting Git archive path");
    paths.add(folded);
    file.path = path;
    const bytes = Buffer.from(file.content, "base64");
    size += bytes.length;
    if (
      bytes.length !== file.size ||
      createHash("sha256").update(bytes).digest("hex") !== file.sha256
    )
      throw new Error("Git archive hash or length mismatch");
    if (size > 256 * 1024 * 1024) throw new Error("Git restore exceeds archive size limit");
  }
  for (const path of paths)
    for (const parent of path
      .split("/")
      .slice(0, -1)
      .map((_, i) =>
        path
          .split("/")
          .slice(0, i + 1)
          .join("/"),
      ))
      if (paths.has(parent)) throw new Error("Git archive path is both a file and directory");
  if (!paths.has("head")) throw new Error("Git backup has no HEAD");
  return data;
}
async function targetRevision(request: BackupRestoreRequest) {
  if (!request.destinationPath || !isAbsolute(request.destinationPath))
    throw new Error("Select an absolute destination directory");
  const path = resolve(request.destinationPath);
  const parent = await realpath(dirname(path));
  if (resolve(parent) !== dirname(path))
    throw new Error("Restore destination parent must not be a symbolic link");
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory() || (await readdir(path)).length)
      throw new Error("Restore destination must be a new or empty directory");
    return {
      path,
      revision: JSON.stringify([path, stats.dev, stats.ino, stats.mtimeMs, stats.ctimeMs]),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { path, revision: `missing:${path}` };
    throw error;
  }
}
async function run(command: GitCommandProvider, cwd: string, args: string[]) {
  const result = await command.run({
    cwd,
    args,
    env: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
    },
    maxOutputBytes: 1024 * 1024,
  });
  if (result.exitCode !== 0 || result.timedOut || result.outputTruncated)
    throw new Error("Restored Git repository failed verification");
  return result.stdout;
}
export function createGitBackupSource(options: GitBackupSnapshotOptions = {}): BackupSourcePort {
  const command = options.commandProvider ?? createGitCommandProvider();
  return {
    async capture(_selection, target?: BackupTarget) {
      if (!target?.workspacePath || !isAbsolute(target.workspacePath))
        throw new Error("Select a Git workspace");
      const snapshot = await captureGitSnapshot(target.workspacePath, options);
      const files = unpackGitBackup(snapshot.packed).map((file, index) => ({
        ...snapshot.entries[index]!,
        path: file.path.replaceAll("\\", "/"),
        content: file.content.toString("base64"),
      }));
      return {
        kind: "git",
        targetKey: gitBackupWorkspaceKey(target),
        label: basename(target.workspacePath),
        selection: null,
        items: [
          { id: gitBackupWorkspaceKey(target), label: basename(target.workspacePath), type: "git" },
        ],
        data: { version: 1, target, files },
      };
    },
    async inspect(snapshot, request) {
      checkedData(snapshot);
      const target = await targetRevision(request);
      return {
        revision: target.revision,
        changes: [{ id: target.path, label: target.path, action: "add" }],
        warnings: [
          "Only committed Git data is restored; uncommitted and untracked files were not backed up.",
          "Hooks are restored into an inactive directory and will not execute.",
        ],
      };
    },
    async restore(snapshot, request, revision) {
      const data = checkedData(snapshot);
      const target = await targetRevision(request);
      if (target.revision !== revision)
        throw new Error("Restore destination changed after preview");
      const staging = join(
        dirname(target.path),
        `.${basename(target.path)}.lcode-restore-${randomUUID()}`,
      );
      await mkdir(join(staging, ".git"), { recursive: true, mode: 0o700 });
      let published = false;
      try {
        for (const file of data.files) {
          const relative = file.path.startsWith("hooks/")
            ? `lcode-backup-disabled-${file.path}`
            : file.path;
          const path = join(staging, ".git", ...relative.split("/"));
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          await writeFile(path, Buffer.from(file.content, "base64"), { flag: "wx", mode: 0o600 });
          if (process.platform !== "win32" && !file.path.startsWith("hooks/"))
            await chmod(path, file.mode ?? 0o600);
        }
        const config = join(staging, ".git", "config");
        const dangerous = await command.run({
          cwd: staging,
          args: [
            "config",
            "--file",
            config,
            "--no-includes",
            "--name-only",
            "--get-regexp",
            "^(include\\.|includeif\\.|filter\\.|core\\.(worktree|hookspath|fsmonitor|sshcommand)|extensions\\.partialclone|remote\\..*\\.promisor)",
          ],
          maxOutputBytes: 64 * 1024,
        });
        if (
          dangerous.stdout ||
          ![0, 1].includes(dangerous.exitCode ?? -1) ||
          dangerous.timedOut ||
          dangerous.outputTruncated
        )
          throw new Error(
            "Git configuration contains external paths, filters or executable helpers; restore was blocked",
          );
        await run(command, staging, [
          "-c",
          "core.hooksPath=",
          "-c",
          "core.fsmonitor=false",
          "fsck",
          "--full",
          "--no-reflogs",
        ]);
        const head = await command.run({ cwd: staging, args: ["rev-parse", "--verify", "HEAD"] });
        if (head.exitCode === 0)
          await run(command, staging, [
            "-c",
            "core.hooksPath=",
            "-c",
            "core.fsmonitor=false",
            "reset",
            "--hard",
            "HEAD",
          ]);
        if ((await targetRevision(request)).revision !== revision)
          throw new Error("Restore destination changed while staging");
        if (!revision.startsWith("missing:")) await rmdir(target.path);
        await rename(staging, target.path);
        published = true;
        return {
          restored: data.files.length,
          warnings: ["Hooks were kept inactive; uncommitted files were not part of the backup."],
        };
      } finally {
        // 仅清理本次生成且已校验的同级 staging，绝不递归删除用户选择的目标目录。
        if (
          !published &&
          dirname(staging) === dirname(target.path) &&
          basename(staging).startsWith(`.${basename(target.path)}.lcode-restore-`)
        )
          await rm(staging, { recursive: true, force: true });
      }
    },
  };
}
