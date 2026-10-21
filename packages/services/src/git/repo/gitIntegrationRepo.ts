import { lstat } from "node:fs/promises";
import { GitIntegrationState } from "./gitIntegrationState.js";
import type {
  GitIntegrationPreviewRequest,
  GitIntegrationSnapshot,
  GitRepositoryRequest,
  GitIntegrationMode,
} from "@lcode/shared";
import { GitNetworkError } from "../gitNetworkJournal.js";
import { GitConflictRepo } from "./gitConflictRepo.js";
import { conflictWorking } from "./gitConflictFiles.js";
import { resolveMutationPath } from "./gitFileMutationRepo.js";
import { fingerprint, type GitWorkspaceSafety } from "./gitWorkspaceSafety.js";

const paths = (raw: string) => raw.split("\0").filter(Boolean);
export class GitIntegrationRepo {
  readonly conflicts: GitConflictRepo;
  readonly native: GitIntegrationState;
  constructor(readonly safety: GitWorkspaceSafety) {
    this.conflicts = new GitConflictRepo(safety);
    this.native = new GitIntegrationState(safety);
  }
  async touched(root: string, mode: GitIntegrationMode, head: string, target: string) {
    const changed = new Set(
      paths(await this.safety.git(root, ["diff", "--name-only", "-z", head, target])),
    );
    // Rebase/abort 会重新 checkout 整棵树；即便两端同名文件未变化，也不能覆盖后加入的忽略/未跟踪文件。
    const parents = (await this.safety.git(root, ["rev-list", "--parents", "-n", "1", target]))
      .trim()
      .split(" ")
      .slice(1);
    for (const tree of [
      head,
      target,
      ...(mode === "cherry-pick" || mode === "revert" ? parents : []),
    ])
      for (const path of paths(
        await this.safety.git(root, ["ls-tree", "-r", "--name-only", "-z", tree]),
      ))
        changed.add(path);
    if (mode === "rebase") {
      const commits = await this.native.replay(root, head, target);
      if (commits.length) {
        const result = await this.safety.command.run({
          cwd: root,
          args: ["diff-tree", "--stdin", "--root", "-r", "--no-commit-id", "--name-only", "-z"],
          stdin: commits.join("\n") + "\n",
          maxOutputBytes: 32 * 1024 ** 2,
        });
        if (result.exitCode !== 0 || result.timedOut || result.outputTruncated || result.orphaned)
          throw new GitNetworkError("git-command-failed");
        for (const path of paths(result.stdout)) changed.add(path);
      }
    }
    return [...changed];
  }
  async assertCollisions(
    root: string,
    touched: string[],
    includeUntracked = false,
    preservedUntracked = new Set<string>(),
  ) {
    const ignored = paths(
      await this.safety.git(root, [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "-z",
      ]),
    );
    const untracked = includeUntracked
      ? paths(
          await this.safety.git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
        ).filter((path) => !preservedUntracked.has(path))
      : [];
    const normalize = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);
    const exact = new Set(touched.map(normalize)),
      parents = new Set<string>();
    for (const path of exact) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) parents.add(parts.slice(0, i).join("/"));
    }
    for (const path of [...ignored, ...untracked].map(normalize)) {
      if (
        exact.has(path) ||
        parents.has(path) ||
        path.split("/").some((_, i, parts) => exact.has(parts.slice(0, i).join("/")))
      )
        throw new GitNetworkError("ignored-collision");
    }
    const resolution = await this.safety.repo.resolveRepository(root);
    for (const path of touched) await resolveMutationPath(resolution, path, true);
  }
  async preview(params: GitIntegrationPreviewRequest) {
    const { safety } = this,
      root = await safety.state.root(params.workspacePath);
    if ((await safety.reservation(params)).blocked) throw new GitNetworkError("checkout-reserved");
    await safety.assertWritable(root);
    if (await safety.git(root, ["status", "--porcelain=v1", "--untracked-files=all"]))
      throw new GitNetworkError("dirty-checkout");
    const state = await safety.state.capture(root);
    if (!state.headCommitHash) throw new GitNetworkError("unborn");
    if (!state.branchName) throw new GitNetworkError("detached");
    const target = (
      await safety.git(root, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${params.targetRef}^{commit}`,
      ])
    ).trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(target))
      throw new GitNetworkError("invalid-target");
    if (
      ["merge", "rebase"].includes(params.mode) &&
      !(await safety.git(root, ["merge-base", state.headCommitHash, target], [0, 1])).trim()
    )
      throw new GitNetworkError("unrelated-histories");
    if ((params.targets || params.mainline) && !["cherry-pick", "revert"].includes(params.mode))
      throw new GitNetworkError("invalid-target");
    if (params.targets && params.targets[0] !== target) throw new GitNetworkError("invalid-target");
    if (params.mainline && params.targets && params.targets.length > 1)
      throw new GitNetworkError("invalid-target");
    for (const item of params.targets ?? [target]) {
      if (params.mode !== "cherry-pick" && params.mode !== "revert") continue;
      const parents = (await safety.git(root, ["rev-list", "--parents", "-n", "1", item]))
        .trim()
        .split(" ")
        .slice(1);
      if (parents.length > 1 && (!params.mainline || params.mainline > parents.length))
        throw new GitNetworkError("mainline-required");
      if (parents.length <= 1 && params.mainline) throw new GitNetworkError("invalid-parent");
      if (
        params.mode === "revert" &&
        (await safety.git(root, ["merge-base", item, state.headCommitHash], [0, 1])).trim() !== item
      )
        throw new GitNetworkError("unreachable-commit");
    }
    for (const tree of [state.headCommitHash, ...(params.targets ?? [target])]) {
      if (
        (await safety.git(root, ["ls-tree", "-r", "-z", tree]))
          .split("\0")
          .some((entry) => /^(?:120000|160000) /.test(entry))
      )
        throw new GitNetworkError("unsupported-checkout");
    }
    const touched = (
      await Promise.all(
        (params.targets ?? [target]).map((item) =>
          this.touched(root, params.mode, state.headCommitHash!, item),
        ),
      )
    ).flat();
    await this.assertCollisions(root, touched);
    const commits =
      params.mode === "rebase" ? await this.native.replay(root, state.headCommitHash, target) : [];
    const native = await this.conflicts.records(params);
    await safety.assertCurrent(root, state);
    return {
      root,
      mode: params.mode,
      targetRef: params.targetRef,
      target,
      head: state.headCommitHash,
      branch: state.branchName,
      commitCount: commits.length,
      ...(params.targets ? { targets: params.targets } : {}),
      ...(params.mainline ? { mainline: params.mainline } : {}),
      revision: fingerprint([
        root,
        params.mode,
        params.targetRef,
        target,
        state,
        native.snapshot.revision,
        commits,
        params.targets,
        params.mainline,
      ]),
    };
  }
  async snapshot(scope: GitRepositoryRequest): Promise<GitIntegrationSnapshot> {
    const { snapshot, owner, ownerInScope } = await this.conflicts.records(scope),
      root = snapshot.root;
    const head =
      (
        await this.safety.git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], [0, 1])
      ).trim() || null;
    const symbolic = (await this.safety.git(root, ["symbolic-ref", "-q", "HEAD"], [0, 1])).trim();
    const branch = symbolic.startsWith("refs/heads/") ? symbolic.slice(11) : null;
    const nativeMode = ["merge", "rebase", "cherry-pick", "revert"].includes(snapshot.operation)
      ? (snapshot.operation as GitIntegrationMode)
      : null;
    const operation = ownerInScope && owner?.integration ? owner : null;
    const files = paths(
      await this.safety.git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]),
    );
    if (files.length > 100_000) throw new GitNetworkError("unsupported-checkout");
    const resolution = await this.safety.repo.resolveRepository(root),
      working: unknown[] = [];
    for (const path of [...new Set(files)].sort()) {
      const selected = await resolveMutationPath(resolution, path, true),
        file = await conflictWorking(selected.absolute);
      if (file.version.size > 64 * 1024 ** 2) throw new GitNetworkError("unsupported-checkout");
      working.push([path, file.fingerprint]);
    }
    const changes = paths(
      await this.safety.git(
        root,
        ["diff", "HEAD", "--no-ext-diff", "--no-textconv", "--name-only", "-z"],
        head ? [0] : [0, 128],
      ),
    );
    const unstaged = await this.safety.git(root, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--name-only",
      "-z",
    ]);
    const untracked = await this.safety.git(root, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    let nativeLocked = false;
    const lock = (
      await this.safety.git(root, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "index.lock",
      ])
    ).trim();
    nativeLocked = Boolean(
      await lstat(lock).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      }),
    );
    const matches = Boolean(
      operation &&
      !operation.resolved &&
      (await this.native.matches(root, operation, nativeMode, head, branch)),
    );
    const message = await this.native.readNative(root, "MERGE_MSG");
    const progress =
      nativeMode === "rebase"
        ? [
            await this.native.readNative(root, "rebase-merge/msgnum"),
            await this.native.readNative(root, "rebase-merge/end"),
          ].join(" / ")
        : null;
    if ((await this.conflicts.records(scope)).snapshot.revision !== snapshot.revision)
      throw new GitNetworkError("stale-preview");
    return {
      root,
      head,
      branch,
      nativeMode,
      operation,
      progress,
      revision: fingerprint([
        snapshot.revision,
        message,
        working,
        changes,
        unstaged,
        untracked,
        nativeLocked,
        operation?.resolved,
        operation?.unsettled,
      ]),
      blocked:
        snapshot.blocked || Boolean((await this.safety.reservation(scope)).blocked && !operation),
      canContinue: matches && !nativeLocked && !snapshot.files.length && !unstaged && !untracked,
      canAbort: matches && !nativeLocked,
      needsNativeConfirmation: Boolean(
        operation && (operation.unsettled || ["running", "unknown"].includes(operation.status)),
      ),
      conflicts: snapshot.files.map((file) => file.path),
      changedFiles: [...new Set([...changes, ...paths(untracked)])],
    };
  }
}
