import { lstat, mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  GitAcquisitionOptions,
  GitAcquisitionPreview,
  GitAcquireRepositoryRequest,
} from "@lcode/shared";
import { GitNetworkError } from "../gitNetworkJournal.js";
import {
  directoryFingerprint,
  fingerprint,
  type GitOperationEffect,
  type GitOperationCheckpoint,
  type GitWorkspaceSafety,
} from "./gitWorkspaceSafety.js";

export class GitAcquisitionRepo {
  constructor(private readonly safety: GitWorkspaceSafety) {}
  async preview(params: GitAcquisitionOptions): Promise<GitAcquisitionPreview> {
    if (params.authentication) {
      if (!this.safety.command.validateAuthentication)
        throw new GitNetworkError("authentication-unavailable");
      try {
        await this.safety.command.validateAuthentication(params.url!, params.authentication);
      } catch (error) {
        const code = error instanceof Error ? error.message : "authentication-unavailable";
        throw new GitNetworkError(
          [
            "stale-account",
            "missing-account",
            "account-server-mismatch",
            "ssh-key-unavailable",
          ].includes(code)
            ? code
            : "authentication-unavailable",
        );
      }
    }
    const directory = await realpath(params.workspacePath);
    const normalize = (path: string) =>
      process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
    if (
      normalize(directory) !== normalize(params.workspacePath) ||
      (await lstat(params.workspacePath)).isSymbolicLink()
    )
      throw new GitNetworkError("invalid-directory");
    const token = await directoryFingerprint(directory);
    const targetPath = params.mode === "clone" ? join(directory, params.targetName!) : directory;
    const existing = await lstat(
      params.mode === "clone" ? targetPath : join(targetPath, ".git"),
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (existing)
      throw new GitNetworkError(params.mode === "clone" ? "target-exists" : "already-repository");
    const parent = await this.safety.command.run({
      cwd: directory,
      args: ["rev-parse", "--show-toplevel"],
    });
    if (parent.timedOut || parent.outputTruncated || parent.orphaned)
      throw new GitNetworkError("git-command-failed");
    if (parent.exitCode !== 0 && !/not a git repository/i.test(parent.stderr))
      throw new GitNetworkError("git-command-failed");
    const parentRepository = parent.exitCode === 0 ? parent.stdout.trim() : null;
    return {
      revision: fingerprint([params, directory, token, targetPath, parentRepository]),
      mode: params.mode,
      targetPath,
      parentRepository,
    };
  }
  async acquire(
    params: GitAcquireRepositoryRequest,
    checkpoint: GitOperationCheckpoint,
  ): Promise<GitOperationEffect> {
    const { options } = params;
    const preview = await this.preview(options);
    if (
      preview.revision !== params.preview.revision ||
      preview.targetPath !== params.preview.targetPath ||
      preview.mode !== params.preview.mode ||
      preview.parentRepository !== params.preview.parentRepository
    )
      throw new GitNetworkError("stale-preview");
    if (options.mode === "init" && preview.parentRepository && !options.allowNested)
      throw new GitNetworkError("nested-repository");
    if (options.mode === "init")
      await this.safety.git(options.workspacePath, [
        "check-ref-format",
        "--branch",
        options.initialBranch ?? "main",
      ]);
    const query = {
      workspacePath: options.workspacePath,
      workspaceIdentity: options.workspaceIdentity,
      requestId: params.requestId,
    };
    // 先持久化目标，再保留写入边界；进程中断后仍能按原请求找到待核对目录。
    await checkpoint({ targetPath: preview.targetPath });
    await this.safety.reserve(query, preview.targetPath, "repository-acquisition");
    let created = options.mode === "init";
    try {
      if (options.mode === "clone") {
        await mkdir(preview.targetPath);
        created = true;
      }
      const result = await this.safety.command.run({
        authentication: options.authentication,
        cwd: options.workspacePath,
        args:
          options.mode === "init"
            ? [
                "-c",
                "core.hooksPath=/dev/null",
                "init",
                "--template=",
                `--initial-branch=${options.initialBranch ?? "main"}`,
                "--",
                preview.targetPath,
              ]
            : [
                "-c",
                "core.hooksPath=/dev/null",
                "clone",
                "--template=",
                "--no-local",
                "--no-recurse-submodules",
                "--",
                options.url!,
                preview.targetPath,
              ],
        timeoutMs: 120_000,
        maxOutputBytes: 2 * 1024 ** 2,
      });
      if (result.orphaned)
        return {
          status: "unknown",
          targetPath: preview.targetPath,
          unsettled: true,
          code: "writer-unsettled",
        };
      this.safety.repo.invalidate(preview.targetPath);
      if (result.timedOut || result.outputTruncated || result.exitCode !== 0)
        return {
          status: "unknown",
          targetPath: preview.targetPath,
          code: "acquisition-incomplete",
        };
      const info = await this.safety.repo.resolveRepository(preview.targetPath);
      if (!info.isRepository || resolve(info.repoRoot) !== resolve(preview.targetPath))
        throw new Error("Incomplete repository");
      const after =
        (
          await this.safety.git(
            preview.targetPath,
            ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
            [0, 1],
          )
        ).trim() || null;
      const effect: GitOperationEffect = {
        status: "success",
        targetPath: preview.targetPath,
        after,
      };
      await checkpoint(effect);
      await this.safety.release(query, preview.targetPath);
      return effect;
    } catch {
      if (!created) {
        await this.safety.release(query, preview.targetPath);
        return { status: "failed", code: "target-exists" };
      }
      return { status: "unknown", targetPath: preview.targetPath, code: "acquisition-incomplete" };
    } finally {
      this.safety.repo.invalidate(options.workspacePath);
    }
  }
}
