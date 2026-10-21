import { lstat } from "node:fs/promises";
import type { GitStashSaveRequest, GitStashApplyRequest } from "@lcode/shared";
import { GitNetworkError } from "../gitNetworkJournal.js";
import type { GitStashRepo } from "./gitStashRepo.js";
import type { GitOperationCheckpoint, GitOperationEffect } from "./gitWorkspaceSafety.js";
import { resolveMutationPath } from "./gitFileMutationRepo.js";

export class GitStashMutations {
  constructor(private readonly repo: GitStashRepo) {}
  async save(
    params: GitStashSaveRequest,
    checkpoint: GitOperationCheckpoint,
  ): Promise<GitOperationEffect> {
    const { safety } = this.repo;
    const before = await this.repo.records(params.workspacePath);
    if (before.revision !== params.expectedRevision) throw new GitNetworkError("stale-preview");
    const cwd = before.cwd;
    await safety.assertWritable(cwd);
    if (!(await safety.state.capture(cwd)).headCommitHash) throw new GitNetworkError("unborn");
    await safety.assertCurrent(params.workspacePath, params.expectedState);
    const changes = await safety.git(cwd, [
      "status",
      "--porcelain=v1",
      params.includeUntracked ? "--untracked-files=all" : "--untracked-files=no",
    ]);
    if (!changes) throw new GitNetworkError("no-changes");
    await checkpoint({ targetPath: cwd });
    await safety.reserve(params, cwd, "stash-save");
    try {
      const result = await safety.command.run({
        cwd,
        args: [
          "-c",
          "core.hooksPath=/dev/null",
          "stash",
          "push",
          ...(params.includeUntracked ? ["--include-untracked"] : []),
          "--message",
          params.message || "LCode stash",
          "--",
        ],
        timeoutMs: 120_000,
      });
      if (result.orphaned)
        return { status: "unknown", targetPath: cwd, unsettled: true, code: "writer-unsettled" };
      const after = await this.repo.records(params.workspacePath);
      const created =
        after.entries.length === before.entries.length + 1 &&
        after.entries.slice(1).every((entry, index) => entry.oid === before.entries[index]?.oid);
      const stashOid = created ? after.entries[0]!.oid : undefined;
      const effect: GitOperationEffect = {
        status:
          !result.timedOut && !result.outputTruncated && result.exitCode === 0 && created
            ? "success"
            : "unknown",
        targetPath: cwd,
        ...(stashOid ? { stashOid } : {}),
        ...(!created ? { code: "stash-outcome-unknown" } : {}),
      };
      await checkpoint(effect);
      if (effect.status === "success") await safety.release(params, cwd);
      return effect;
    } catch {
      return { status: "unknown", targetPath: cwd, code: "stash-outcome-unknown" };
    } finally {
      safety.repo.invalidate(params.workspacePath);
    }
  }
  async apply(
    params: GitStashApplyRequest,
    checkpoint: GitOperationCheckpoint,
  ): Promise<GitOperationEffect> {
    const { safety } = this.repo;
    const records = await this.repo.selection(params);
    const cwd = records.cwd;
    await safety.assertWritable(cwd);
    await safety.assertCurrent(params.workspacePath, params.expectedState);
    if (await safety.git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]))
      throw new GitNetworkError("dirty-checkout");
    const trees = await this.repo.trees(cwd, params.oid);
    const paths = new Set<string>();
    for (const target of [params.oid, trees.index])
      for (const path of (await safety.git(cwd, ["diff", "--name-only", "-z", trees.base, target]))
        .split("\0")
        .filter(Boolean))
        paths.add(path);
    if (trees.untracked)
      for (const path of (
        await safety.git(cwd, ["ls-tree", "-r", "--name-only", "-z", trees.untracked])
      )
        .split("\0")
        .filter(Boolean))
        paths.add(path);
    const resolution = await safety.repo.resolveRepository(cwd);
    const ignored = await safety.command.run({
      cwd,
      args: ["check-ignore", "-z", "--stdin"],
      stdin: [...paths].join("\0") + "\0",
    });
    if (ignored.timedOut || ignored.outputTruncated || ![0, 1].includes(ignored.exitCode!))
      throw new GitNetworkError("git-command-failed");
    for (const path of paths) await resolveMutationPath(resolution, path);
    for (const path of ignored.stdout.split("\0").filter(Boolean)) {
      const selected = await resolveMutationPath(resolution, path);
      const exists = await lstat(selected.absolute).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (exists) throw new GitNetworkError("ignored-collision");
    }
    await checkpoint({ targetPath: cwd, stashOid: params.oid });
    await safety.reserve(params, cwd, "stash-apply");
    try {
      const result = await safety.command.run({
        cwd,
        args: [
          "-c",
          "core.hooksPath=/dev/null",
          "stash",
          "apply",
          ...(params.restoreIndex ? ["--index"] : []),
          "--",
          params.oid,
        ],
        timeoutMs: 120_000,
      });
      if (result.orphaned)
        return {
          status: "unknown",
          targetPath: cwd,
          stashOid: params.oid,
          unsettled: true,
          code: "writer-unsettled",
        };
      const conflicts = await safety.conflicts(cwd);
      const effect: GitOperationEffect = {
        targetPath: cwd,
        stashOid: params.oid,
        conflicts,
        status: conflicts.length
          ? "conflict"
          : result.timedOut || result.outputTruncated
            ? "unknown"
            : result.exitCode === 0
              ? "success"
              : "partial",
        ...(conflicts.length
          ? { code: "stash-conflict" }
          : result.exitCode === 0
            ? {}
            : { code: "stash-outcome-unknown" }),
      };
      await checkpoint(effect);
      if (effect.status === "success") await safety.release(params, cwd);
      return effect;
    } catch {
      return {
        status: "unknown",
        targetPath: cwd,
        stashOid: params.oid,
        code: "stash-outcome-unknown",
      };
    } finally {
      safety.repo.invalidate(params.workspacePath);
    }
  }
}
