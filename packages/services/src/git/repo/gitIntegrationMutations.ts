import type {
  GitIntegrationActionRequest,
  GitStartIntegrationRequest,
  GitNetworkOperation,
  GitOperationQuery,
} from "@lcode/shared";
import { GitNetworkError } from "../gitNetworkJournal.js";
import { type GitOperationCheckpoint, type GitOperationEffect } from "./gitWorkspaceSafety.js";
import type { GitIntegrationRepo } from "./gitIntegrationRepo.js";

const config = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "merge.autoStash=false",
  "-c",
  "rebase.autoStash=false",
  "-c",
  "rebase.updateRefs=false",
  "-c",
  "rerere.enabled=false",
  "-c",
  "submodule.recurse=false",
  "-c",
  "maintenance.auto=false",
  "-c",
  "gc.auto=0",
  "-c",
  "rebase.abbreviateCommands=false",
  "-c",
  "rebase.instructionFormat=%s",
];
export class GitIntegrationMutations {
  constructor(readonly repo: GitIntegrationRepo) {}
  async start(
    params: GitStartIntegrationRequest,
    checkpoint: GitOperationCheckpoint,
  ): Promise<GitOperationEffect> {
    const { preview } = params,
      { safety } = this.repo;
    const actual = await this.repo.preview({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      mode: preview.mode,
      targetRef: preview.targetRef,
      targets: preview.targets,
      mainline: preview.mainline,
    });
    if (
      Object.entries(actual).some(
        ([key, value]) =>
          JSON.stringify(value) !== JSON.stringify(preview[key as keyof typeof preview]),
      )
    )
      throw new GitNetworkError("stale-preview");
    const integration = {
      mode: preview.mode,
      head: preview.head,
      branch: preview.branch,
      target: preview.target,
      ...(preview.targets ? { targets: preview.targets } : {}),
      ...(preview.mainline ? { mainline: preview.mainline } : {}),
    };
    await checkpoint({ targetPath: actual.root, before: actual.head, integration });
    await safety.reserve(params, actual.root, "integration");
    return this.execute(
      params,
      params,
      {
        requestId: params.requestId,
        kind: preview.mode,
        status: "running",
        startedAt: new Date().toISOString(),
        targetPath: actual.root,
        integration,
      },
      preview.mode === "merge"
        ? [
            "-c",
            `branch.${preview.branch}.mergeOptions=`,
            "merge",
            "--ff",
            "--commit",
            "--no-squash",
            "--no-autostash",
            "--no-overwrite-ignore",
            "--no-edit",
            "--no-gpg-sign",
            "--",
            preview.target,
          ]
        : preview.mode !== "rebase"
          ? [
              preview.mode,
              "--no-edit",
              "--no-gpg-sign",
              ...(preview.mainline ? ["--mainline", String(preview.mainline)] : []),
              "--",
              ...(preview.targets ?? [preview.target]),
            ]
          : [
              "rebase",
              "--merge",
              "--no-autostash",
              "--no-update-refs",
              "--no-autosquash",
              "--no-rebase-merges",
              "--no-fork-point",
              "--reapply-cherry-picks",
              "--empty=stop",
              "--keep-empty",
              "--no-gpg-sign",
              preview.target,
            ],
      false,
      checkpoint,
    );
  }
  async action(
    params: GitIntegrationActionRequest,
    abort: boolean,
    checkpoint: GitOperationCheckpoint,
  ): Promise<GitOperationEffect> {
    const query = {
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      requestId: params.sourceRequestId,
    };
    const original = await this.repo.conflicts.authority(query, params.confirmNativeStopped);
    if (
      !original.integration ||
      !["merge", "rebase", "cherry-pick", "revert"].includes(original.kind)
    )
      throw new GitNetworkError("missing-operation");
    const current = await this.repo.snapshot(params);
    if (
      current.operation?.requestId !== params.sourceRequestId ||
      current.revision !== params.expectedRevision
    )
      throw new GitNetworkError("stale-preview");
    if (abort ? !current.canAbort || !params.confirmDiscard : !current.canContinue)
      throw new GitNetworkError(
        abort && !params.confirmDiscard ? "discard-confirmation-required" : "integration-not-ready",
      );
    const { integration } = original;
    const touched = (
      await Promise.all(
        (integration.targets ?? [integration.target]).map((target) =>
          this.repo.touched(current.root, integration.mode, integration.head, target),
        ),
      )
    ).flat();
    await this.repo.assertCollisions(current.root, touched, abort);
    if ((await this.repo.snapshot(params)).revision !== current.revision)
      throw new GitNetworkError("stale-preview");
    await checkpoint({
      targetPath: current.root,
      sourceRequestId: query.requestId,
      integration,
      before: current.head,
    });
    // 子命令发生前先给原 owner 留下恢复边界；进程/Host 在回执前退出也不能默认为安全可写。
    await this.repo.safety.journal.markUnsettled(query);
    return this.execute(
      params,
      query,
      original,
      [integration.mode, abort ? "--abort" : "--continue"],
      abort,
      checkpoint,
    );
  }
  private async execute(
    params: GitOperationQuery,
    query: GitOperationQuery,
    original: GitNetworkOperation,
    args: string[],
    abort: boolean,
    checkpoint: GitOperationCheckpoint,
  ): Promise<GitOperationEffect> {
    const { safety } = this.repo,
      root = original.targetPath!,
      integration = original.integration!;
    const source = params.requestId === query.requestId ? {} : { sourceRequestId: query.requestId };
    const unknown = (unsettled = false): GitOperationEffect => ({
      status: "unknown",
      targetPath: root,
      integration,
      ...source,
      code: unsettled ? "writer-unsettled" : "integration-outcome-unknown",
      ...(unsettled ? { unsettled: true } : {}),
    });
    try {
      const result = await safety.command.run({
        cwd: root,
        args: [...config, ...args],
        timeoutMs: 120_000,
        env: {
          GIT_EDITOR: "true",
          GIT_SEQUENCE_EDITOR: "true",
          GIT_MERGE_AUTOEDIT: "no",
          GIT_TERMINAL_PROMPT: "0",
        },
      });
      if (result.orphaned) {
        if (params.requestId !== query.requestId) await safety.journal.markUnsettled(query);
        return unknown(true);
      }
      if (result.timedOut || result.outputTruncated || result.exitCode === null) return unknown();
      const snapshot = await this.repo.snapshot(query);
      const after = snapshot.head;
      let terminal =
        result.exitCode === 0 &&
        !snapshot.nativeMode &&
        (await safety.idle(root)) &&
        !snapshot.conflicts.length &&
        snapshot.branch === integration.branch &&
        Boolean(after);
      if (terminal) {
        if (abort) terminal = after === integration.head;
        else if (integration.mode === "cherry-pick" || integration.mode === "revert")
          terminal = await this.repo.native.completed(root, integration, after!);
        else
          for (const ancestor of integration.mode === "merge"
            ? [integration.head, integration.target]
            : [integration.target]) {
            if (
              !(await safety.git(root, ["merge-base", ancestor, after!], [0, 1]))
                .trim()
                .startsWith(ancestor)
            )
              terminal = false;
          }
      }
      const effect: GitOperationEffect = {
        targetPath: root,
        integration,
        ...source,
        after,
        conflicts: await safety.conflicts(root),
        status: terminal
          ? "success"
          : snapshot.conflicts.length
            ? "conflict"
            : snapshot.nativeMode
              ? "partial"
              : "unknown",
        resolved: terminal,
        unsettled: false,
        ...(!terminal
          ? {
              code: snapshot.conflicts.length
                ? "integration-conflict"
                : snapshot.nativeMode
                  ? "integration-paused"
                  : "integration-outcome-unknown",
            }
          : {}),
      };
      await checkpoint(effect);
      if (params.requestId !== query.requestId)
        await safety.journal.updateIntegration(query, effect);
      if (terminal) await safety.release(query, root);
      return effect;
    } catch {
      return unknown();
    } finally {
      safety.repo.invalidate(root);
    }
  }
}
