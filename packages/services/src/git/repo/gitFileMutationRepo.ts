import { lstat, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { normalizeGitPath } from "../config.js";
import type { GitCommandProvider } from "../providers/gitCommandProvider.js";
import { ensureGitCommandSucceeded, ensureRepositoryAvailable } from "./gitCliHelpers.js";
import type { GitResolvedRepository, GitStatusSnapshot } from "./gitCliTypes.js";
import { batchGitPathspecs } from "./gitPathspecBatches.js";

type Action = "stage" | "unstage" | "discard" | "discard-staged";
const outside = (path: string) => path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);

/** 验证具体文件，保留最终符号链接本身，拒绝通过父链接操作其它文件。 */
export async function resolveMutationPath(
  resolution: GitResolvedRepository,
  input: string,
  allowDirectoryRead = false,
) {
  const workspace = resolve(resolution.workspacePath);
  const raw = isAbsolute(input) ? resolve(input) : resolve(workspace, input);
  const local = relative(workspace, raw);
  if (!local || outside(local) || local.split(sep).some((part) => part.toLowerCase() === ".git"))
    throw new Error(`Path is outside workspace file scope: ${input}`);
  const canonicalWorkspace = await realpath(workspace);
  const absolute = resolve(canonicalWorkspace, local);
  const repoPath = normalizeGitPath(relative(await realpath(resolution.repoRoot), absolute));
  if (outside(repoPath.split("/").join(sep)))
    throw new Error(`Path is outside repository: ${input}`);
  for (let parent = dirname(absolute); parent !== canonicalWorkspace; parent = dirname(parent)) {
    const info = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (info?.isSymbolicLink()) throw new Error(`Symbolic link directory is not allowed: ${input}`);
  }
  const info = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (
    info &&
    !info.isFile() &&
    !info.isSymbolicLink() &&
    !(allowDirectoryRead && info.isDirectory())
  )
    throw new Error(`Select concrete files instead of directories: ${input}`);
  return { repoPath, absolute };
}

export async function resolveMutationSelection(
  snapshot: GitStatusSnapshot,
  inputs: string[],
  action?: Action,
) {
  const resolution = ensureRepositoryAvailable(
    snapshot.resolution,
    action ?? "commit selected files",
  );
  const cwd = resolution.repoRoot;
  if (!inputs.length) throw new Error("Select at least one concrete file.");
  if (snapshot.entries.some((entry) => entry.isConflicted))
    throw new Error("Resolve Git conflicts before managing files.");
  const selected = await Promise.all(inputs.map((input) => resolveMutationPath(resolution, input)));
  const entries = selected.map(({ repoPath }) => {
    const entry = snapshot.entries.find(
      (item) => item.path === repoPath || item.originalPath === repoPath,
    );
    if (
      !entry ||
      ((action === "unstage" || action === "discard-staged") && (!entry.x || entry.x === "."))
    )
      throw new Error(`File is no longer in the selected Git source: ${repoPath}`);
    if (
      (action === "stage" || action === "discard") &&
      !entry.isUntracked &&
      (!entry.y || entry.y === ".")
    )
      throw new Error(`File has no working tree changes: ${repoPath}`);
    return entry;
  });
  const paths = [
    ...new Set(
      entries.flatMap((entry) => [entry.path, ...(entry.originalPath ? [entry.originalPath] : [])]),
    ),
  ];
  // 原路径也必须整批校验；否则子工作区的 rename 会顺带写入相邻工作区。
  await Promise.all(paths.map((path) => resolveMutationPath(resolution, resolve(cwd, path))));
  return { entries, paths };
}

export async function mutateGitFiles(
  command: GitCommandProvider,
  snapshot: GitStatusSnapshot,
  inputs: string[],
  action: Action,
) {
  const { entries, paths } = await resolveMutationSelection(snapshot, inputs, action);
  const { resolution } = snapshot;
  const cwd = resolution.repoRoot;
  const run = async (args: string[]) => {
    const result = await command.run({ cwd, args: ["--literal-pathspecs", ...args] });
    ensureGitCommandSucceeded(`git ${action}`, result);
    return result.stdout;
  };
  const runPaths = async (args: string[], selected: string[]) => {
    let output = "";
    for (const batch of batchGitPathspecs(selected)) output += await run([...args, "--", ...batch]);
    return output;
  };
  const modes = await runPaths(["ls-files", "--stage", "-z"], paths);
  if (modes.split("\0").some((entry) => entry.startsWith("160000 ")))
    throw new Error("Use the dedicated submodule workflow to manage submodules.");
  if (action === "stage") {
    await runPaths(["add", "-A"], paths);
    return;
  }
  if (action === "discard") {
    const tracked = [
      ...new Set(
        entries
          .filter((entry) => !entry.isUntracked)
          .flatMap((entry) => [entry.path, ...(entry.originalPath ? [entry.originalPath] : [])]),
      ),
    ];
    if (tracked.length) await runPaths(["restore", "--worktree"], tracked);
    for (const entry of entries.filter(
      (item, index) => item.isUntracked && entries.indexOf(item) === index,
    )) {
      const { absolute } = await resolveMutationPath(resolution, resolve(cwd, entry.path));
      // 只 unlink 具体已确认文件，绝不递归删除目录或采用 git clean 的隐式扩张。
      await unlink(absolute);
    }
    return;
  }
  const head = await command.run({ cwd, args: ["rev-parse", "--verify", "HEAD"] });
  if (head.exitCode !== 0) {
    // 首次提交前没有 HEAD，restore --staged 会失败；确认 unborn 后仅移出 index，保留文件。
    ensureGitCommandSucceeded("git HEAD", head, [128]);
    const ref = (await run(["symbolic-ref", "--quiet", "HEAD"])).trim();
    const absent = await command.run({ cwd, args: ["show-ref", "--verify", "--quiet", ref] });
    ensureGitCommandSucceeded("git unborn branch", absent, [1]);
    if (action === "discard-staged")
      throw new Error("Cannot discard staged files before the first commit; unstage them instead.");
    await runPaths(["rm", "--cached", "--force"], paths);
    return;
  }
  ensureGitCommandSucceeded("git HEAD", head);
  if (action === "unstage") {
    await runPaths(["restore", "--staged"], paths);
    return;
  }
  const oid = head.stdout.trim();
  const inHead = (await runPaths(["ls-tree", "-r", "--name-only", "-z", oid], paths))
    .split("\0")
    .filter(Boolean);
  // 新暂存文件没有 HEAD 版本；只移出 index，保留工作树，避免 restore 双区域删除内容。
  await runPaths(["restore", `--source=${oid}`, "--staged"], paths);
  if (inHead.length) await runPaths(["restore", `--source=${oid}`, "--worktree"], inHead);
}
