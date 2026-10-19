import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_MEMORY_RECORD_MAX_BYTES, type ProjectMemoryReview } from "@lcode/contracts";
import { throwIfAborted } from "./file-system-common.js";
import { assertMemoryRoot, type MemoryRoot } from "./project-memory-paths.js";
import { memoryError, MEMORY_TEMP_PREFIX, readMemoryBytes } from "./project-memory-io.js";
import { readMemoryRecordHeader } from "./project-memory-record-pages.js";

export interface MemoryReviewHeader {
  id: string;
  createdAt: number;
  revision: number;
  itemCount: number;
  partial: boolean;
}

/** 原因：历史总量放开后不能为列表还原全部长提案；只遍历固定大小的主记录摘要。 */
export async function* readMemoryReviewHeaders(
  root: MemoryRoot,
  readReview: (id: string) => Promise<ProjectMemoryReview>,
  signal?: AbortSignal,
): AsyncGenerator<MemoryReviewHeader> {
  await assertMemoryRoot(root);
  for await (const entry of await opendir(join(root.stateDir, "reviews"))) {
    throwIfAborted(signal);
    if (entry.name.startsWith(MEMORY_TEMP_PREFIX) && entry.name.endsWith(".tmp")) continue;
    if (
      entry.isSymbolicLink() ||
      !entry.isFile() ||
      !/^[a-zA-Z0-9_-]{8,96}\.json$/u.test(entry.name)
    )
      throw memoryError("invalid_path", entry.name, "Invalid memory proposal entry");
    const id = entry.name.slice(0, -5);
    const path = join(root.stateDir, "reviews", entry.name);
    const primary = await readMemoryBytes(path, PROJECT_MEMORY_RECORD_MAX_BYTES);
    let header = readMemoryRecordHeader(root, path, primary!);
    if (!header) {
      const review = await readReview(id);
      header = {
        id: review.id,
        createdAt: review.createdAt,
        revision: review.revision,
        itemCount: review.draft.items.length,
        partial: review.draft.partial,
      };
    }
    if (header.id !== id) throw memoryError("io_error", id, "Memory proposal identity changed");
    await assertMemoryRoot(root);
    yield header;
  }
}
