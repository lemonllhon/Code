import type {
  GitHistoryResetOptions,
  GitHistoryResetPreview,
  GitHistoryResetRequest,
  GitNetworkOperation,
  GitOperationQuery,
} from "@lcode/shared";
import { GitNetworkError, gitOperationKey } from "../gitNetworkJournal.js";
import {
  fingerprint,
  type GitOperationCheckpoint,
  type GitOperationEffect,
} from "./gitWorkspaceSafety.js";
import { GitIntegrationRepo } from "./gitIntegrationRepo.js";
import type { GitHistoryRepo } from "./gitHistoryRepo.js";
import { createServiceLogger } from "../../logger/serviceLogger.js";
const logger = createServiceLogger("GitHistoryReset");
export class GitHistoryResetRepo {
  constructor(private readonly history: GitHistoryRepo) {}
  private async inspect(scope: GitOperationQuery | GitHistoryResetOptions) {
    const { safety } = this.history,
      root = await safety.state.root(scope.workspacePath);
    if ((await safety.reservation(scope)).blocked) throw new GitNetworkError("checkout-reserved");
    await safety.assertWritable(root);
    const state = await safety.state.capture(root);
    if (!state.headCommitHash) throw new GitNetworkError("unborn");
    if (!state.branchName) throw new GitNetworkError("detached");
    return { root, state, head: state.headCommitHash, branch: state.branchName };
  }
  async preview(
    params: GitHistoryResetOptions,
    preservedUntracked = new Set<string>(),
  ): Promise<GitHistoryResetPreview> {
    const { root, state, head, branch } = await this.inspect(params),
      { safety } = this.history;
    const target = (
      await this.history.git(root, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${params.target}^{commit}`,
      ])
    ).trim();
    const integration = new GitIntegrationRepo(safety);
    for (const tree of [head, target])
      if (
        (await this.history.git(root, ["ls-tree", "-r", "-z", tree]))
          .split("\0")
          .some((entry) => /^(?:120000|160000) /.test(entry))
      )
        throw new GitNetworkError("unsupported-checkout");
    if (params.mode === "hard")
      await integration.assertCollisions(
        root,
        await integration.touched(root, "merge", head, target),
        true,
        preservedUntracked,
      );
    const trackedChanges = Boolean(
      await this.history.git(root, ["status", "--porcelain=v1", "--untracked-files=no"]),
    );
    await safety.assertCurrent(root, state);
    return {
      root,
      head,
      branch,
      target,
      mode: params.mode,
      trackedChanges,
      revision: fingerprint([root, state, target, params.mode, trackedChanges]),
    };
  }
  async recovery(query: GitOperationQuery): Promise<GitHistoryResetPreview> {
    const original = await this.history.safety.journal.get(query),
      backup = original?.historyReset;
    if (
      !backup ||
      original?.kind !== "history-reset" ||
      original.status !== "success" ||
      backup.restored ||
      !backup.afterRevision
    )
      throw new GitNetworkError("missing-operation");
    const { root, state } = await this.inspect(query);
    if (fingerprint(state) !== backup.afterRevision) throw new GitNetworkError("stale-recovery");
    if (
      (await this.history.git(root, ["rev-parse", "--verify", backup.backupRef])).trim() !==
        backup.head ||
      (backup.stashRef &&
        (await this.history.git(root, ["rev-parse", "--verify", backup.stashRef])).trim() !==
          backup.stashOid)
    )
      throw new GitNetworkError("stale-recovery");
    // mixed 会把旧 index 中的新增文件变为 untracked；只有成功结果完全未变化且原 index 树证明归属时，恢复可覆盖这些自身保留的文件。
    const preserved = new Set(
      (
        await this.history.git(root, [
          "ls-tree",
          "-r",
          "--name-only",
          "-z",
          backup.stashOid ? `${backup.stashOid}^2` : backup.head,
        ])
      )
        .split("\0")
        .filter(Boolean),
    );
    const preview = await this.preview(
      {
        workspacePath: query.workspacePath,
        workspaceIdentity: query.workspaceIdentity,
        target: backup.head,
        mode: "hard",
      },
      preserved,
    );
    return {
      ...preview,
      sourceRequestId: query.requestId,
      recovery: backup,
      revision: fingerprint([preview.revision, query.requestId, backup]),
    };
  }
  async execute(
    params: GitHistoryResetRequest,
    checkpoint: GitOperationCheckpoint,
  ): Promise<GitOperationEffect> {
    const { preview } = params,
      { safety } = this.history;
    const actual = preview.sourceRequestId
      ? await this.recovery({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          requestId: preview.sourceRequestId,
        })
      : await this.preview({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          target: preview.target,
          mode: preview.mode,
        });
    if (
      Object.keys(actual).length !== Object.keys(preview).length ||
      Object.entries(actual).some(
        ([key, value]) =>
          JSON.stringify(value) !== JSON.stringify(preview[key as keyof typeof preview]),
      )
    )
      throw new GitNetworkError("stale-preview");
    if (preview.mode === "hard" && !params.confirmDiscard)
      throw new GitNetworkError("discard-confirmation-required");
    const root = actual.root,
      state = await safety.state.capture(root);
    if (
      actual.recovery
        ? fingerprint(state) !== actual.recovery.afterRevision
        : fingerprint([root, state, actual.target, actual.mode, actual.trackedChanges]) !==
          actual.revision
    )
      throw new GitNetworkError("stale-preview");
    const indexBefore = fingerprint(await this.history.git(root, ["ls-files", "--stage", "-z"]));
    const prefix = `refs/lcode/history-recovery/${gitOperationKey(params)}`;
    let metadata: NonNullable<GitNetworkOperation["historyReset"]> = actual.recovery ?? {
      mode: preview.mode,
      head: preview.head,
      target: preview.target,
      branch: preview.branch,
      backupRef: `${prefix}/head`,
      stashRef: null,
      stashOid: null,
      beforeWorktree: state.worktreeFingerprint,
      beforeIndex: indexBefore,
    };
    await checkpoint({
      targetPath: root,
      before: actual.head,
      historyReset: metadata,
      ...(preview.sourceRequestId ? { sourceRequestId: preview.sourceRequestId } : {}),
    });
    await safety.reserve(params, root, "integration");
    let unsettled = false;
    const write = async (args: string[]) => {
      const result = await safety.command.run({
        cwd: root,
        args: [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "rerere.enabled=false",
          "-c",
          "submodule.recurse=false",
          ...args,
        ],
        timeoutMs: 120000,
        env: { GIT_TERMINAL_PROMPT: "0" },
      });
      unsettled ||= Boolean(result.orphaned);
      if (result.exitCode !== 0 || result.timedOut || result.outputTruncated || result.orphaned)
        throw new GitNetworkError("reset-outcome-unknown");
      return result.stdout.trim();
    };
    try {
      if (!actual.recovery) {
        const zero = "0".repeat(actual.head.length);
        await write(["update-ref", metadata.backupRef, actual.head, zero]);
        if (actual.trackedChanges) {
          const stashOid = await write(["stash", "create"]);
          if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(stashOid))
            throw new GitNetworkError("reset-outcome-unknown");
          metadata = { ...metadata, stashOid, stashRef: `${prefix}/stash` };
          await checkpoint({ historyReset: metadata });
          await write(["update-ref", metadata.stashRef!, stashOid, zero]);
        }
      }
      // stash create 会刷新 index 的 stat cache，字节指纹随之改变；校验 HEAD、内容与暂存条目语义，避免把自身备份误报为并发写入。
      const current = await safety.state.capture(root);
      if (
        current.headCommitHash !== state.headCommitHash ||
        current.branchName !== state.branchName ||
        current.worktreeFingerprint !== state.worktreeFingerprint ||
        current.remoteConfigFingerprint !== state.remoteConfigFingerprint ||
        fingerprint(await this.history.git(root, ["ls-files", "--stage", "-z"])) !== indexBefore
      )
        throw new GitNetworkError("stale-preview");
      await safety.assertWritable(root);
      await write(["reset", `--${preview.mode}`, preview.target, "--"]);
      if (actual.recovery?.stashOid)
        await write(["stash", "apply", "--index", actual.recovery.stashOid]);
      safety.repo.invalidate(root);
      const after = await safety.state.capture(root),
        index = fingerprint(await this.history.git(root, ["ls-files", "--stage", "-z"]));
      let valid =
        after.headCommitHash === preview.target &&
        after.branchName === preview.branch &&
        (await safety.idle(root));
      if (actual.recovery)
        valid &&=
          after.worktreeFingerprint === metadata.beforeWorktree && index === metadata.beforeIndex;
      else if (preview.mode === "soft")
        valid &&=
          after.worktreeFingerprint === state.worktreeFingerprint && index === metadata.beforeIndex;
      else if (preview.mode === "mixed")
        valid &&= after.worktreeFingerprint === state.worktreeFingerprint;
      else
        valid &&= !(await this.history.git(root, [
          "status",
          "--porcelain=v1",
          "--untracked-files=no",
        ]));
      if (!valid) throw new GitNetworkError("reset-outcome-unknown");
      metadata = {
        ...metadata,
        afterRevision: fingerprint(after),
        ...(actual.recovery ? { restored: true } : {}),
      };
      await checkpoint({ after: after.headCommitHash!, historyReset: metadata });
      await safety.release(params, root);
      return {
        status: "success",
        after: after.headCommitHash!,
        historyReset: metadata,
        resolved: true,
      };
    } catch (error) {
      logger.warn(undefined, "Reset did not reach a verified terminal state", {
        code: error instanceof GitNetworkError ? error.code : "git-command-failed",
      });
      // 原生命令可能已改变 HEAD/index；不能将异常当作未执行，更不能自动重放 Reset。
      return {
        status: "unknown",
        code: "reset-outcome-unknown",
        unsettled,
        historyReset: metadata,
      };
    } finally {
      safety.repo.invalidate(root);
    }
  }
}
