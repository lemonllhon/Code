import type { ProjectMemoryPort, ProjectMemoryOperationOptions } from "@lcode/contracts";
import { checkMemoryTarget, type MemoryRoot } from "./project-memory-paths.js";
import { checkedMemoryChunks, describeMemoryFile } from "./project-memory-stream.js";
import { memoryError } from "./project-memory-io.js";

const MAX_PAGE_BYTES = 256 * 1024;

/** 原因：随机页完整核验适用于编辑；召回逐页重算全文 hash 会形成平方 IO，必须流式消费。 */
export async function* iterateMemoryContentPages(
  root: MemoryRoot,
  input: { fileName: string; maxBytes: number },
  options?: ProjectMemoryOperationOptions,
): AsyncGenerator<Awaited<ReturnType<NonNullable<ProjectMemoryPort["readContentPage"]>>>> {
  if (
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes < 4 ||
    input.maxBytes > MAX_PAGE_BYTES
  )
    throw memoryError("invalid_limit", input.fileName, "Invalid memory stream page size");
  const path = await checkMemoryTarget(root, input.fileName);
  const source = await describeMemoryFile(path, options?.signal);
  if (!source) throw memoryError("not_found", path, "Memory file disappeared");
  let pending = Buffer.alloc(0),
    offset = 0;
  const emit = (bytes: Buffer) => {
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw memoryError("unsupported", path, "Memory byte stream requires UTF-8");
    }
    const page = {
      content,
      hash: source.hash,
      offset,
      bytesRead: bytes.length,
      sizeBytes: source.size,
      ...(offset + bytes.length < source.size ? { nextOffset: offset + bytes.length } : {}),
    };
    offset += bytes.length;
    return page;
  };
  for await (const chunk of checkedMemoryChunks(source, options?.signal)) {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= input.maxBytes) {
      options?.signal?.throwIfAborted();
      let boundary = input.maxBytes;
      let tail = boundary - 1;
      while (tail > 0 && (pending[tail]! & 0xc0) === 0x80) tail--;
      const lead = pending[tail]!;
      const width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
      if (tail + width > boundary) boundary = tail;
      yield emit(pending.subarray(0, boundary));
      pending = pending.subarray(boundary);
    }
  }
  options?.signal?.throwIfAborted();
  if (pending.length || !source.size) yield emit(pending);
  options?.signal?.throwIfAborted();
  await checkMemoryTarget(root, input.fileName);
}
