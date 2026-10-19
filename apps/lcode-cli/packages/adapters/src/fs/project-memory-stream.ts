import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { getNodeErrorCode, throwIfAborted } from "./file-system-common.js";
import { memoryError } from "./project-memory-io.js";

const STREAM_BYTES = 64 * 1024;
export interface MemoryFileSource {
  path: string;
  hash: string;
  size: number;
}

/** 固定缓冲区覆盖整文件；stat 与打开后的身份均校验，不能跟随被替换的链接。 */
export async function* memoryFileChunks(
  path: string,
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  const initial = await lstat(path);
  if (initial.isSymbolicLink() || !initial.isFile())
    throw memoryError("invalid_path", path, "Memory source must be a regular file");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (before.dev !== initial.dev || before.ino !== initial.ino || !before.isFile())
      throw memoryError("stale_write", path, "Memory source changed while opening");
    let position = 0;
    for (;;) {
      throwIfAborted(signal);
      const buffer = Buffer.alloc(STREAM_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
    const after = await handle.stat();
    const current = await lstat(path);
    if (
      current.isSymbolicLink() ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      after.size !== position ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw memoryError("stale_write", path, "Memory source changed while streaming");
  } finally {
    await handle.close();
  }
}

export async function describeMemoryFile(
  path: string,
  signal?: AbortSignal,
): Promise<MemoryFileSource | null> {
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of memoryFileChunks(path, signal)) {
      hash.update(chunk);
      size += chunk.length;
    }
  } catch (error) {
    if (getNodeErrorCode(error) === "ENOENT") return null;
    throw error;
  }
  return { path, size, hash: `sha256:${hash.digest("hex")}` };
}

export async function* checkedMemoryChunks(
  source: MemoryFileSource,
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  const hash = createHash("sha256");
  for await (const chunk of memoryFileChunks(source.path, signal)) {
    hash.update(chunk);
    yield chunk;
  }
  if (`sha256:${hash.digest("hex")}` !== source.hash)
    throw memoryError("stale_write", source.path, "Memory source revision changed");
}

/** range 来自冻结证据；未读取的前后正文以流保持原字节，不经过模型重写。 */
export async function* spliceMemoryChunks(
  source: MemoryFileSource,
  replacement: Buffer,
  range: { offset: number; length: number },
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  if (
    !Number.isSafeInteger(range.offset) ||
    !Number.isSafeInteger(range.length) ||
    range.offset < 0 ||
    range.length < 0 ||
    range.offset + range.length > source.size
  )
    throw memoryError("invalid_limit", source.path, "Invalid memory replacement range");
  let position = 0;
  let inserted = false;
  for await (const chunk of checkedMemoryChunks(source, signal)) {
    const end = position + chunk.length;
    if (position < range.offset)
      yield chunk.subarray(0, Math.min(chunk.length, range.offset - position));
    if (!inserted && end >= range.offset) {
      yield replacement;
      inserted = true;
    }
    if (end > range.offset + range.length)
      yield chunk.subarray(Math.max(0, range.offset + range.length - position));
    position = end;
  }
  if (!inserted) yield replacement;
}
