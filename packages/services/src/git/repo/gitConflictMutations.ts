import { randomUUID } from "node:crypto";
import { open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  GitBeginConflictRequest,
  GitSaveConflictRequest,
  GitMarkConflictRequest,
} from "@lcode/shared";
import { GitNetworkError } from "../gitNetworkJournal.js";
import type { GitConflictRepo } from "./gitConflictRepo.js";
import type { GitOperationCheckpoint, GitOperationEffect } from "./gitWorkspaceSafety.js";
import { MAX_CONFLICT_TEXT, conflictWorking, readConflictIndex } from "./gitConflictFiles.js";

/** 只释放本次成功创建且尚未发布的原生锁，不能清除其它 Git 进程的 index.lock。 */
async function withIndexLock<T>(
  path: string,
  action: (lock: {
    handle: Awaited<ReturnType<typeof open>>;
    publish: () => Promise<void>;
    retain: () => void;
  }) => Promise<T>,
) {
  const lockPath = `${path}.lock`;
  const handle = await open(lockPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new GitNetworkError("git-lock-busy");
    throw error;
  });
  let owned = true;
  try {
    return await action({
      handle,
      retain: () => {
        owned = false;
      },
      publish: async () => {
        await handle.sync();
        await handle.close();
        await rename(lockPath, path);
        owned = false;
      },
    });
  } finally {
    await handle.close().catch(() => {});
    if (owned)
      await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
  }
}
export class GitConflictMutations {
  constructor(readonly repo: GitConflictRepo) {}
  async begin(
    params: GitBeginConflictRequest,
    checkpoint: GitOperationCheckpoint,
  ): Promise<GitOperationEffect> {
    const before = await this.repo.records(params);
    return withIndexLock(before.indexPath, async () => {
      const current = await this.repo.records(params);
      if (current.snapshot.revision !== params.expectedRevision)
        throw new GitNetworkError("stale-conflict");
      if (current.snapshot.blocked || current.snapshot.sourceRequestId)
        throw new GitNetworkError("checkout-reserved");
      if (!current.snapshot.files.length) throw new GitNetworkError("missing-conflict");
      await checkpoint({
        targetPath: current.snapshot.root,
        conflicts: current.snapshot.files.map(({ path, stages }) => ({ path, stages })),
      });
      await this.repo.safety.reserve(params, current.snapshot.root, "conflict-resolution");
      return { status: "conflict", targetPath: current.snapshot.root };
    });
  }
  private async selected(params: GitSaveConflictRequest | GitMarkConflictRequest) {
    await this.repo.authority(
      {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        requestId: params.sourceRequestId,
      },
      params.confirmNativeStopped,
    );
    const current = await this.repo.file(params);
    if (current.detail.revision !== params.expectedRevision)
      throw new GitNetworkError("stale-conflict");
    if (
      current.records.snapshot.sourceRequestId !== params.sourceRequestId ||
      current.records.snapshot.blocked
    )
      throw new GitNetworkError("checkout-reserved");
    return current;
  }
  async save(
    params: GitSaveConflictRequest,
    checkpoint: GitOperationCheckpoint,
  ): Promise<GitOperationEffect> {
    const before = await this.selected(params);
    if (!before.detail.editable) throw new GitNetworkError("unsupported-conflict");
    const bytes = params.action === "save" ? Buffer.from(params.text!) : null;
    if (bytes && (bytes.length > MAX_CONFLICT_TEXT || bytes.toString("utf8") !== params.text))
      throw new GitNetworkError("unsupported-conflict");
    return withIndexLock(before.records.indexPath, async () => {
      const current = await this.selected(params);
      await checkpoint({ targetPath: current.records.snapshot.root, filePath: params.path });
      let temporary: string | null = null,
        writing = false;
      try {
        if (bytes) {
          const name = join(dirname(current.absolute), `.lcode-conflict-${randomUUID()}`);
          const file = await open(name, "wx", current.working.mode || 0o644);
          temporary = name;
          try {
            await file.writeFile(bytes);
            await file.chmod(current.working.mode || 0o644);
            await file.sync();
          } finally {
            await file.close();
          }
        }
        // 临时文件写入期间允许外部编辑器工作；发布前重验原文件与 index，避免覆盖已观察到的新版本。
        await this.selected(params);
        writing = true;
        if (temporary) {
          await rename(temporary, current.absolute);
          temporary = null;
        } else if (current.detail.result.kind !== "absent") await unlink(current.absolute);
        this.repo.safety.repo.invalidate(params.workspacePath);
        return { status: "success", targetPath: current.records.snapshot.root };
      } catch (error) {
        if (writing)
          return {
            status: "unknown",
            targetPath: current.records.snapshot.root,
            code: "conflict-outcome-unknown",
          };
        throw error;
      } finally {
        if (temporary)
          await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
      }
    });
  }
  async mark(
    params: GitMarkConflictRequest,
    checkpoint: GitOperationCheckpoint,
  ): Promise<GitOperationEffect> {
    const before = await this.selected(params);
    if (!before.detail.canMark || (!before.detail.editable && !params.confirmSpecial))
      throw new GitNetworkError("unsupported-conflict");
    return withIndexLock(before.records.indexPath, async (lock) => {
      const current = await this.selected(params),
        index = join(dirname(current.records.indexPath), `index.lcode-conflict-${randomUUID()}`);
      await checkpoint({ targetPath: current.records.snapshot.root, filePath: params.path });
      let retain = false,
        publishing = false,
        owned = false;
      try {
        await writeFile(index, current.records.index, { flag: "wx", mode: 0o600 });
        owned = true;
        const native = await this.repo.safety.command.run({
          cwd: current.records.snapshot.root,
          args: [
            "--literal-pathspecs",
            "-c",
            "core.hooksPath=/dev/null",
            "add",
            "-A",
            "--",
            params.path,
          ],
          env: { GIT_INDEX_FILE: index },
          timeoutMs: 120_000,
        });
        if (native.orphaned) {
          retain = true;
          lock.retain();
          try {
            await this.repo.safety.journal.markUnsettled({
              workspacePath: params.workspacePath,
              workspaceIdentity: params.workspaceIdentity,
              requestId: params.sourceRequestId,
            });
          } catch {
            /* 原收据写入失败也必须保留原生锁和 writer，本次仍按 unknown 结算。 */
          }
          return {
            status: "unknown",
            targetPath: current.records.snapshot.root,
            unsettled: true,
            code: "writer-unsettled",
          };
        }
        if (native.timedOut || native.outputTruncated)
          return {
            status: "unknown",
            targetPath: current.records.snapshot.root,
            code: "conflict-outcome-unknown",
          };
        if (native.exitCode !== 0) throw new GitNetworkError("git-command-failed");
        const verified = await this.repo.safety.command.run({
          cwd: current.records.snapshot.root,
          args: ["--literal-pathspecs", "ls-files", "--unmerged", "-z", "--", params.path],
          env: { GIT_INDEX_FILE: index },
        });
        if (
          verified.timedOut ||
          verified.outputTruncated ||
          verified.exitCode !== 0 ||
          verified.stdout
        )
          throw new GitNetworkError("unsupported-conflict");
        const working = await conflictWorking(current.absolute);
        if (
          working.fingerprint !== current.working.fingerprint ||
          !current.records.index.equals(await readConflictIndex(current.records.indexPath)) ||
          (await this.repo.records(params)).snapshot.revision !== current.records.snapshot.revision
        )
          throw new GitNetworkError("stale-conflict");
        const next = await readConflictIndex(index);
        await lock.handle.writeFile(next);
        publishing = true;
        await lock.publish();
        this.repo.safety.repo.invalidate(params.workspacePath);
        return { status: "success", targetPath: current.records.snapshot.root };
      } catch (error) {
        if (publishing)
          return {
            status: "unknown",
            targetPath: current.records.snapshot.root,
            code: "conflict-outcome-unknown",
          };
        throw error;
      } finally {
        if (owned && !retain) {
          await unlink(index).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
          await unlink(`${index}.lock`).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      }
    });
  }
}
