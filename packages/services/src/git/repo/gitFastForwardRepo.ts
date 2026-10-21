import { access } from "node:fs/promises";
import type {
  GitNetworkSnapshot,
  GitFastForwardPreview,
  GitFastForwardRequest,
  GitNetworkOperation,
} from "@lcode/shared";
import type { GitCommandProvider } from "../providers/gitCommandProvider.js";
import type { GitCliRepo } from "./gitCliTypes.js";
import { GitPublishStateReader, assertPublishState } from "./gitPublishState.js";
import { GitNetworkError } from "../gitNetworkJournal.js";
type Effect = Partial<GitNetworkOperation>;
export class GitFastForwardRepo {
  constructor(
    private readonly repo: GitCliRepo,
    private readonly command: GitCommandProvider,
    private readonly state: GitPublishStateReader,
    private readonly snapshot: (path: string) => Promise<GitNetworkSnapshot>,
  ) {}
  private git(cwd: string, args: string[]) {
    return this.state.git(cwd, args);
  }
  private async idle(cwd: string) {
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
  async preview(workspacePath: string): Promise<GitFastForwardPreview> {
    const snapshot = await this.snapshot(workspacePath);
    const cwd = await this.state.root(workspacePath);
    const target =
      snapshot.remoteBranches.find((item) => `${item.remote}/${item.branch}` === snapshot.upstream)
        ?.head ?? null;
    const base = {
      revision: snapshot.revision,
      branch: snapshot.branch,
      head: snapshot.head,
      upstream: snapshot.upstream,
      target,
      state: null,
    };
    if (!snapshot.branch) return { ...base, reason: "detached" };
    if (!snapshot.head) return { ...base, reason: "unborn" };
    if (!(await this.idle(cwd))) return { ...base, reason: "operation-in-progress" };
    if (!snapshot.upstream) return { ...base, reason: "no-upstream" };
    if (!target) return { ...base, reason: "missing-upstream" };
    if ((await this.git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"])).length)
      return { ...base, reason: "dirty" };
    if (snapshot.ahead > 0 && snapshot.behind > 0) return { ...base, reason: "diverged" };
    if (snapshot.behind === 0) return { ...base, reason: "up-to-date" };
    // assume-unchanged / skip-worktree 会隐藏本地修改；不能把 status 的空结果当作安全覆盖许可。
    if (
      (await this.git(cwd, ["ls-files", "-v", "-z"]))
        .split("\0")
        .some((entry) => entry && !entry.startsWith("H "))
    )
      return { ...base, reason: "unsupported" };
    try {
      return { ...base, state: await this.state.capture(workspacePath), reason: "ready" };
    } catch {
      return { ...base, reason: "unsupported" };
    }
  }
  async fastForward(params: GitFastForwardRequest): Promise<Effect> {
    const preview = params.preview;
    if (
      params.expectedRevision !== preview.revision ||
      preview.reason !== "ready" ||
      !preview.state ||
      !preview.target ||
      !preview.head
    )
      throw new GitNetworkError("invalid-preview");
    if ((await this.snapshot(params.workspacePath)).revision !== preview.revision)
      throw new GitNetworkError("stale-preview");
    const actual = await this.preview(params.workspacePath);
    if (
      actual.revision !== preview.revision ||
      actual.reason !== "ready" ||
      actual.target !== preview.target ||
      actual.head !== preview.head ||
      actual.branch !== preview.branch ||
      actual.upstream !== preview.upstream
    )
      throw new GitNetworkError("stale-preview");
    try {
      assertPublishState(preview.state, actual.state!);
    } catch {
      throw new GitNetworkError("stale-preview");
    }
    const cwd = await this.state.root(params.workspacePath);
    // 确认后的工作树更新固定到已审核 OID；不读移动的 upstream、不执行隐式合并或用户 hook。
    try {
      const result = await this.command.run({
        cwd,
        args: [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "merge.autostash=false",
          "-c",
          "maintenance.auto=false",
          "merge",
          "--ff-only",
          "--no-autostash",
          "--no-overwrite-ignore",
          "--no-edit",
          "--no-gpg-sign",
          "--",
          preview.target,
        ],
        timeoutMs: 120_000,
      });
      if (result.orphaned)
        return {
          status: "unknown",
          before: preview.head,
          code: "writer-unsettled",
          unsettled: true,
        };
      this.repo.invalidate(params.workspacePath);
      const after = (await this.snapshot(params.workspacePath)).head;
      const unknown =
        result.timedOut || result.outputTruncated || result.orphaned || result.exitCode === null;
      return {
        status: unknown
          ? "unknown"
          : result.exitCode === 0 && after === preview.target
            ? "success"
            : "failed",
        before: preview.head,
        after,
        ...(unknown
          ? {
              code: result.orphaned ? "writer-unsettled" : "outcome-unknown",
              ...(result.orphaned ? { unsettled: true } : {}),
            }
          : result.exitCode === 0 && after === preview.target
            ? {}
            : { code: "fast-forward-failed" }),
      };
    } catch {
      return { status: "unknown", before: preview.head, code: "outcome-unknown" };
    } finally {
      this.repo.invalidate(params.workspacePath);
    }
  }
}
