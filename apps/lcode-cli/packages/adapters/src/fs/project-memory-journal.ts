import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { type ProjectMemoryChange, type ProjectMemoryOperationOptions } from "@lcode/contracts";
import { getNodeErrorCode, hashBuffer, throwIfAborted } from "./file-system-common.js";
import { memoryError, strictAtomicWrite } from "./project-memory-io.js";
import { assertMemoryRoot, checkMemoryTarget } from "./project-memory-paths.js";
import { MemoryStore } from "./project-memory-store.js";
import {
  checkedMemoryChunks,
  describeMemoryFile,
  spliceMemoryChunks,
  type MemoryFileSource,
} from "./project-memory-stream.js";

export interface MemoryCommit {
  fileName: string;
  content: Buffer | MemoryFileSource;
  expectedHash: string | null;
  range?: { offset: number; length: number };
  createParents?: boolean;
  undoOf?: string;
  proposalId?: string;
  proposalItemId?: string;
  onStaged?: (mtimeMs: number) => void;
}

export class MemoryJournal {
  constructor(readonly store: MemoryStore) {}

  private async currentHash(change: ProjectMemoryChange): Promise<string | null> {
    const path = await checkMemoryTarget(this.store.root, change.fileName);
    return (await describeMemoryFile(path))?.hash ?? null;
  }

  private async recoverChange(
    change: ProjectMemoryChange,
    knownUnpublished = false,
  ): Promise<ProjectMemoryChange> {
    let status: ProjectMemoryChange["status"] = "recovery-required";
    try {
      const hash = await this.currentHash(change);
      status =
        knownUnpublished && hash === change.beforeHash
          ? "not-committed"
          : hash === change.afterHash
            ? "committed"
            : hash === change.beforeHash
              ? "not-committed"
              : "recovery-required";
    } catch (error) {
      // 缺失父目录也属于目标不存在；其他不可读/链接/超预算情况只标记人工恢复。
      await assertMemoryRoot(this.store.root);
      if (getNodeErrorCode(error) === "ENOENT" && change.beforeHash === null)
        status = "not-committed";
    }
    const recovered = { ...change, status };
    await this.store.writeChange(recovered);
    return recovered;
  }

  async recover(options?: ProjectMemoryOperationOptions): Promise<ProjectMemoryChange[]> {
    const changes = await this.store.readChanges();
    for (let index = 0; index < changes.length; index += 1) {
      throwIfAborted(options?.signal);
      if (changes[index]!.status === "prepared")
        changes[index] = await this.recoverChange(changes[index]!);
    }
    return changes;
  }

  async commit(
    input: MemoryCommit,
    changes: readonly ProjectMemoryChange[],
    options?: ProjectMemoryOperationOptions,
  ): Promise<ProjectMemoryChange> {
    const { root } = this.store;
    throwIfAborted(options?.signal);
    if (
      changes.some(
        (change) => change.status === "recovery-required" || change.status === "prepared",
      )
    ) {
      throw memoryError(
        "stale_write",
        root.rootDir,
        "Project Memory has unresolved recovery records; writes are blocked",
      );
    }
    const path = await checkMemoryTarget(root, input.fileName, input.createParents);
    const before = await describeMemoryFile(path, options?.signal);
    const beforeHash = before?.hash ?? null;
    if (input.expectedHash !== beforeHash)
      throw memoryError("stale_write", path, "Project Memory changed since the approved full read");
    if (input.range && !before)
      throw memoryError("stale_write", path, "A range replacement requires an existing source");
    const produce = () =>
      Buffer.isBuffer(input.content)
        ? input.range && before
          ? spliceMemoryChunks(before, input.content, input.range, options?.signal)
          : input.content
        : checkedMemoryChunks(input.content, options?.signal);
    const hash = createHash("sha256");
    const generated = produce();
    if (Buffer.isBuffer(generated)) hash.update(generated);
    else for await (const chunk of generated) hash.update(chunk);
    let mode = 0o600;
    try {
      mode = (await lstat(path)).mode & 0o777;
    } catch (error) {
      if (getNodeErrorCode(error) !== "ENOENT") throw error;
    }
    const change: ProjectMemoryChange = {
      schemaVersion: 1,
      id: randomUUID(),
      fileName: input.fileName,
      createdAt: Date.now(),
      beforeHash,
      afterHash: `sha256:${hash.digest("hex")}`,
      ...(input.range && Buffer.isBuffer(input.content)
        ? { replacementHash: hashBuffer(input.content) }
        : {}),
      status: "prepared",
      ...(options?.trace?.sessionId ? { sessionId: options.trace.sessionId } : {}),
      ...(input.undoOf ? { undoOf: input.undoOf } : {}),
      ...(input.proposalId
        ? { proposalId: input.proposalId, proposalItemId: input.proposalItemId }
        : {}),
    };
    throwIfAborted(options?.signal);
    await this.store.reserveChange(change, before, options);
    let published = false;
    try {
      await strictAtomicWrite(path, produce(), {
        expectedMissing: before === null,
        mode,
        signal: options?.signal,
        tempDirectory: join(root.stateDir, "staging"),
        onStaged: input.onStaged,
        validate: async () => {
          await checkMemoryTarget(root, input.fileName);
        },
        beforePublish: async () => {
          const actual = await describeMemoryFile(path, options?.signal);
          if ((actual?.hash ?? null) !== beforeHash) {
            throw memoryError(
              "stale_write",
              path,
              "Project Memory changed before atomic publication",
            );
          }
        },
        onPublished: () => {
          published = true;
        },
      });
    } catch (error) {
      const recovered = await this.recoverChange(change, !published);
      if (published && recovered.status === "committed") return recovered;
      throw error;
    }
    // rename/link 已成功后取消不能再把提交报告成未提交；失败只留 prepared 给下一次恢复。
    const committed: ProjectMemoryChange = { ...change, status: "committed" };
    await this.store.writeChange(committed);
    return committed;
  }

  async replaceForUndo(
    changeId: string,
    changes: readonly ProjectMemoryChange[],
  ): Promise<{ change: ProjectMemoryChange; before: MemoryFileSource }> {
    const change = changes.find((entry) => entry.id === changeId);
    if (!change) throw memoryError("not_found", changeId, "Project Memory change does not exist");
    if (change.beforeHash === null)
      throw memoryError(
        "unsupported",
        changeId,
        "Project Memory undo only supports replace; create deletion is not available",
      );
    if (
      change.status !== "committed" ||
      changes.some((entry) => entry.undoOf === change.id && entry.status === "committed")
    ) {
      throw memoryError(
        "stale_write",
        changeId,
        "Project Memory change is not an undoable committed replacement",
      );
    }
    return { change, before: await this.store.readPreimageSource(change) };
  }
}
