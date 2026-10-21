import { createHash } from "node:crypto";
import { access, lstat, readdir, realpath } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import type {
  GitNetworkOperation,
  GitOperationQuery,
  GitRepositoryRequest,
  GitCompleteOperationRequest,
  GitCompleteOperationPreview,
  GitPublishState,
} from "@lcode/shared";
import type { CheckoutCoordinator, CheckoutReservation } from "../../worktree/node.js";
import type { GitCommandProvider } from "../providers/gitCommandProvider.js";
import type { GitCliRepo } from "./gitCliTypes.js";
import { GitPublishStateReader, assertPublishState } from "./gitPublishState.js";
import { GitNetworkJournal, GitNetworkError, gitOperationKey } from "../gitNetworkJournal.js";

export const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type GitOperationEffect = Partial<GitNetworkOperation>;
export type GitOperationCheckpoint = (effect: GitOperationEffect) => Promise<void>;
export async function directoryFingerprint(path: string) {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new GitNetworkError("invalid-directory");
  const entries = await readdir(path);
  const records = await Promise.all(
    entries.sort().map(async (name) => {
      const item = await lstat(join(path, name), { bigint: true });
      return [
        name,
        String(item.ino),
        String(item.mode),
        String(item.size),
        String(item.mtimeNs),
        String(item.ctimeNs),
      ];
    }),
  );
  return fingerprint([await realpath(path), String(info.dev), String(info.ino), records]);
}

export class GitWorkspaceSafety {
  readonly state: GitPublishStateReader;
  constructor(
    readonly repo: GitCliRepo,
    readonly command: GitCommandProvider,
    readonly journal: GitNetworkJournal,
    readonly coordinator?: CheckoutCoordinator,
  ) {
    this.state = new GitPublishStateReader(repo, command);
  }
  git(cwd: string, args: string[], allowed = [0]) {
    return this.state.git(cwd, args, allowed);
  }
  async assertCurrent(path: string, expected: GitPublishState) {
    const actual = await this.state.capture(path);
    try {
      assertPublishState(expected, actual);
    } catch {
      throw new GitNetworkError("stale-preview");
    }
  }
  async idle(cwd: string) {
    for (const marker of [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
      "sequencer",
      "index.lock",
    ]) {
      const path = (
        await this.git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", marker])
      ).trim();
      try {
        await access(path);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return true;
  }
  async conflicts(cwd: string): Promise<NonNullable<GitNetworkOperation["conflicts"]>> {
    const raw = await this.git(cwd, ["ls-files", "--unmerged", "-z"]);
    const files = new Map<string, NonNullable<GitNetworkOperation["conflicts"]>[number]>();
    for (const entry of raw.split("\0").filter(Boolean)) {
      const match = /^([0-7]{6}) ([a-f0-9]+) ([1-3])\t([\s\S]+)$/.exec(entry);
      if (!match) throw new GitNetworkError("invalid-index");
      const path = match[4]!;
      const file = files.get(path) ?? { path, stages: [] };
      file.stages.push({ mode: match[1]!, oid: match[2]!, stage: Number(match[3]) });
      files.set(path, file);
    }
    return [...files.values()];
  }
  async assertWritable(cwd: string) {
    if (!(await this.idle(cwd)) || (await this.conflicts(cwd)).length)
      throw new GitNetworkError("operation-in-progress");
    if (
      (await this.git(cwd, ["ls-files", "-v", "-z"]))
        .split("\0")
        .some((entry) => entry && !entry.startsWith("H "))
    )
      throw new GitNetworkError("unsupported-checkout");
  }
  async reserve(scope: GitOperationQuery, targetPath: string, kind: CheckoutReservation["kind"]) {
    if (!this.coordinator?.setReservation) throw new GitNetworkError("missing-coordinator");
    await this.coordinator.setReservation({
      workspacePath: targetPath,
      operationKey: gitOperationKey(scope),
      kind,
    });
  }
  async release(scope: GitOperationQuery, targetPath: string) {
    if (!this.coordinator?.clearReservation) throw new GitNetworkError("missing-coordinator");
    await this.coordinator.clearReservation({
      workspacePath: targetPath,
      operationKey: gitOperationKey(scope),
    });
  }
  async reservation(scope: GitRepositoryRequest) {
    const reservation = await this.coordinator?.getReservation?.(scope);
    return {
      blocked: Boolean(reservation),
      operation: reservation ? await this.journal.reserved(scope, reservation.operationKey) : null,
    };
  }
  async completionPreview(query: GitOperationQuery): Promise<GitCompleteOperationPreview> {
    const original = await this.journal.get(query);
    if (
      !original?.targetPath ||
      ![
        "repository-init",
        "repository-clone",
        "stash-save",
        "stash-apply",
        "conflict-resolution",
        "merge",
        "rebase",
        "cherry-pick",
        "revert",
        "history-reset",
        "history-reset-restore",
      ].includes(original.kind)
    )
      throw new GitNetworkError("missing-operation");
    const exists = await lstat(original.targetPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" || original.kind !== "repository-clone") throw error;
      return null;
    });
    // clone 可在 mkdir 前中断；恢复以父目录核对缺失目标，不能因 realpath 失败永久卡住 reservation。
    const targetPath = exists
      ? await realpath(original.targetPath)
      : join(await realpath(dirname(original.targetPath)), basename(original.targetPath));
    const reservation = await this.coordinator?.getReservation?.({ workspacePath: targetPath });
    if (!reservation && !original.resolved) throw new GitNetworkError("missing-operation");
    if (reservation && reservation.operationKey !== gitOperationKey(query))
      throw new GitNetworkError("checkout-reserved");
    this.repo.invalidate(targetPath);
    const resolution = exists
      ? await this.repo.resolveRepository(targetPath)
      : { isRepository: false };
    const conflicts = resolution.isRepository ? await this.conflicts(targetPath) : [];
    const idle = resolution.isRepository ? await this.idle(targetPath) : true;
    const state =
      resolution.isRepository && !conflicts.length
        ? ["conflict-resolution", "merge", "rebase", "cherry-pick", "revert"].includes(
            original.kind,
          )
          ? await Promise.all([
              this.git(targetPath, ["rev-parse", "HEAD"]),
              this.git(targetPath, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
              this.git(targetPath, ["ls-files", "--stage", "-z"]),
            ])
          : await this.state.capture(targetPath)
        : null;
    const directory = await directoryFingerprint(exists ? targetPath : dirname(targetPath));
    const revision = fingerprint([
      query.requestId,
      original.kind,
      targetPath,
      state,
      conflicts,
      exists ? directory : ["missing-target", directory],
    ]);
    return {
      sourceRequestId: query.requestId,
      targetPath,
      revision,
      conflicts: conflicts.map((file) => file.path),
      canComplete: idle && !conflicts.length,
      needsNativeConfirmation:
        original.status === "unknown" ||
        original.status === "running" ||
        Boolean(original.unsettled),
    };
  }
  async complete(
    params: GitCompleteOperationRequest,
    checkpoint: GitOperationCheckpoint,
  ): Promise<GitOperationEffect> {
    const query = {
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      requestId: params.sourceRequestId,
    };
    const preview = await this.completionPreview(query);
    if (
      !preview.canComplete ||
      preview.revision !== params.expectedRevision ||
      (preview.needsNativeConfirmation && !params.confirmNativeStopped)
    )
      throw new GitNetworkError("stale-recovery");
    await checkpoint({ targetPath: preview.targetPath, resolved: true });
    await this.journal.markResolved(query);
    await this.release(query, preview.targetPath);
    return { status: "success", targetPath: preview.targetPath, resolved: true };
  }
}
