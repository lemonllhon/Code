import { createHash } from "node:crypto";
import type { ProjectMemoryOperationOptions, ProjectMemoryPort } from "@lcode/contracts";
import { checkMemoryTarget, type MemoryRoot } from "./project-memory-paths.js";
import { memoryFileChunks } from "./project-memory-stream.js";
import { memoryError } from "./project-memory-io.js";

export async function readMemoryContentPage(
  root: MemoryRoot,
  input: Parameters<NonNullable<ProjectMemoryPort["readContentPage"]>>[0],
  options?: ProjectMemoryOperationOptions,
) {
  const path = await checkMemoryTarget(root, input.fileName);
  const page = await readMemoryContentFilePage(path, input, options);
  // 读取期间替换父目录也必须拒绝，不能只检查末级文件是不是链接。
  await checkMemoryTarget(root, input.fileName);
  return page;
}

export async function readMemoryContentFilePage(
  path: string,
  input: { offset?: number; maxBytes: number; expectedHash?: string },
  options?: ProjectMemoryOperationOptions,
) {
  const offset = input.offset ?? 0;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes < 4 ||
    input.maxBytes > 256 * 1024
  )
    throw memoryError("invalid_limit", path, "Invalid memory page size or offset");
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const selected: Buffer[] = [];
  for await (const chunk of memoryFileChunks(path, options?.signal)) {
    hash.update(chunk);
    const start = Math.max(offset - sizeBytes, 0);
    const end = Math.min(chunk.length, offset + input.maxBytes - sizeBytes);
    if (end > start) selected.push(chunk.subarray(start, end));
    sizeBytes += chunk.length;
  }
  const revision = `sha256:${hash.digest("hex")}`;
  if ((input.expectedHash && revision !== input.expectedHash) || offset > sizeBytes)
    throw memoryError("stale_write", path, "Memory content revision changed");
  let bytes = Buffer.concat(selected);
  if (offset && bytes.length && (bytes[0]! & 0xc0) === 0x80)
    throw memoryError("invalid_limit", path, "Memory cursor is not a UTF-8 boundary");
  if (offset + bytes.length < sizeBytes) {
    let tail = bytes.length - 1;
    while (tail > 0 && (bytes[tail]! & 0xc0) === 0x80) tail--;
    const lead = bytes[tail]!;
    const width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
    if (tail + width > bytes.length) bytes = bytes.subarray(0, tail);
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw memoryError(
      "unsupported",
      path,
      "Memory byte pages require UTF-8; use the legacy text reader for other encodings",
    );
  }
  return {
    content,
    hash: revision,
    offset,
    bytesRead: bytes.length,
    sizeBytes,
    ...(offset + bytes.length < sizeBytes ? { nextOffset: offset + bytes.length } : {}),
  };
}
