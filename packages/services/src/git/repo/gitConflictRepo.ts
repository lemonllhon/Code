import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  GitConflictEntry,
  GitConflictFileRequest,
  GitConflictSnapshot,
  GitRepositoryRequest,
  GitOperationQuery,
} from "@lcode/shared";
import { GitNetworkError, gitOperationKey } from "../gitNetworkJournal.js";
import { fingerprint, type GitWorkspaceSafety } from "./gitWorkspaceSafety.js";
import { conflictBlob, conflictWorking, digest, readConflictIndex } from "./gitConflictFiles.js";
import { resolveMutationPath } from "./gitFileMutationRepo.js";
import { GitIntegrationState } from "./gitIntegrationState.js";

export class GitConflictRepo {
  constructor(readonly safety: GitWorkspaceSafety) {}
  async records(scope: GitRepositoryRequest) {
    const root = await this.safety.state.root(scope.workspacePath);
    const gitDir = (await this.safety.git(root, ["rev-parse", "--absolute-git-dir"])).trim();
    const indexPath = resolve(
      root,
      (await this.safety.git(root, ["rev-parse", "--git-path", "index"])).trim(),
    );
    const index = await readConflictIndex(indexPath);
    const head = await this.safety.git(
      root,
      ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      [0, 1],
    );
    const symbolic = await this.safety.git(root, ["symbolic-ref", "-q", "HEAD"], [0, 1]);
    const markers: unknown[] = [];
    let operation: GitConflictSnapshot["operation"] = "index";
    for (const [name, type] of [
      ["MERGE_HEAD", "merge"],
      ["CHERRY_PICK_HEAD", "cherry-pick"],
      ["REVERT_HEAD", "revert"],
      ["rebase-merge", "rebase"],
      ["rebase-apply", "rebase"],
      ["sequencer", "cherry-pick"],
    ] as const) {
      const path = join(gitDir, name),
        info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return null;
        });
      if (!info) continue;
      if (info.isSymbolicLink()) throw new GitNetworkError("unsupported-conflict");
      operation = type;
      const names = info.isDirectory() ? (await readdir(path)).sort() : [""];
      if (names.length > 128) throw new GitNetworkError("unsupported-conflict");
      for (const child of names) {
        const file = child ? join(path, child) : path,
          stat = await lstat(file);
        if (stat.isSymbolicLink() || stat.size > 1024 * 1024)
          throw new GitNetworkError("unsupported-conflict");
        markers.push([
          name,
          child,
          stat.mode,
          stat.isFile() ? digest(await readFile(file)) : stat.mtimeMs,
        ]);
      }
    }
    const files = (await this.safety.conflicts(root)).map((file): GitConflictEntry => {
      const mask = file.stages.reduce((mask, item) => mask | (1 << (item.stage - 1)), 0);
      return {
        ...file,
        kind:
          mask === 7
            ? "both-modified"
            : mask === 6
              ? "both-added"
              : mask === 5
                ? "deleted-by-us"
                : mask === 3
                  ? "deleted-by-them"
                  : "complex",
      };
    });
    const reservation = await this.safety.coordinator?.getReservation?.({ workspacePath: root });
    const owner = reservation
      ? await this.safety.journal.reserved(scope, reservation.operationKey)
      : null;
    if (owner?.kind === "stash-apply" && operation === "index") operation = "stash";
    const ownerInScope =
      owner &&
      ["stash-apply", "conflict-resolution", "merge", "rebase", "cherry-pick", "revert"].includes(
        owner.kind,
      ) &&
      !owner.resolved &&
      (process.platform === "win32"
        ? resolve(owner.targetPath ?? "").toLowerCase() === resolve(root).toLowerCase()
        : resolve(owner.targetPath ?? "") === resolve(root));
    // 整合 marker 被外部替换后，不能仅凭仍存在的 reservation 编辑另一场整合。
    const ownerAllowed =
      ownerInScope &&
      (!owner.integration ||
        (await new GitIntegrationState(this.safety).matches(
          root,
          owner,
          operation,
          head.trim() || null,
          symbolic.trim().startsWith("refs/heads/") ? symbolic.trim().slice(11) : null,
        )));
    const snapshot: GitConflictSnapshot = {
      root,
      revision: fingerprint([
        root,
        head,
        symbolic,
        digest(index),
        markers,
        files,
        reservation?.operationKey ?? null,
      ]),
      operation,
      sourceRequestId: ownerAllowed ? owner.requestId : null,
      blocked: Boolean(reservation && !ownerAllowed),
      nativeCheck: Boolean(
        ownerAllowed && (["running", "unknown"].includes(owner.status) || owner.unsettled),
      ),
      files,
    };
    if (!index.equals(await readConflictIndex(indexPath)))
      throw new GitNetworkError("stale-conflict");
    return { snapshot, indexPath, index, owner, ownerInScope };
  }
  async file(params: GitConflictFileRequest) {
    const records = await this.records(params),
      { snapshot } = records;
    const entry = snapshot.files.find((entry) => entry.path === params.path);
    if (!entry) throw new GitNetworkError("missing-conflict");
    const resolution = await this.safety.repo.resolveRepository(snapshot.root);
    const selected = await resolveMutationPath(resolution, params.path, true);
    const [base, ours, theirs, result] = await Promise.all([
      conflictBlob(
        this.safety,
        snapshot.root,
        entry.stages.find((entry) => entry.stage === 1),
      ),
      conflictBlob(
        this.safety,
        snapshot.root,
        entry.stages.find((entry) => entry.stage === 2),
      ),
      conflictBlob(
        this.safety,
        snapshot.root,
        entry.stages.find((entry) => entry.stage === 3),
      ),
      conflictWorking(selected.absolute),
    ]);
    const editable =
      entry.kind !== "complex" &&
      [base, ours, theirs, result.version].every((version) =>
        ["absent", "text"].includes(version.kind),
      );
    if ((await this.records(params)).snapshot.revision !== snapshot.revision)
      throw new GitNetworkError("stale-conflict");
    const hasMarkers =
      result.version.kind === "text" && /^(?:<{7,} |={7,}$|>{7,} )/m.test(result.version.text!);
    return {
      records,
      absolute: selected.absolute,
      working: result,
      detail: {
        path: params.path,
        revision: fingerprint([snapshot.revision, params.path, result.fingerprint]),
        entry,
        base,
        ours,
        theirs,
        result: result.version,
        editable,
        hasMarkers,
        canMark:
          !hasMarkers &&
          ["absent", "text", "binary", "encoding"].includes(result.version.kind) &&
          !entry.stages.some((stage) => ["120000", "160000"].includes(stage.mode)),
      },
    };
  }
  async authority(query: GitOperationQuery, confirmNativeStopped: boolean) {
    const original = await this.safety.journal.get(query);
    if (
      !original?.targetPath ||
      original.resolved ||
      !["stash-apply", "conflict-resolution", "merge", "rebase", "cherry-pick", "revert"].includes(
        original.kind,
      )
    )
      throw new GitNetworkError("missing-operation");
    const reservation = await this.safety.coordinator?.getReservation?.({
      workspacePath: original.targetPath,
    });
    if (!reservation || reservation.operationKey !== gitOperationKey(query))
      throw new GitNetworkError("checkout-reserved");
    if (
      (["running", "unknown"].includes(original.status) || original.unsettled) &&
      !confirmNativeStopped
    )
      throw new GitNetworkError("native-check-required");
    return original;
  }
}
