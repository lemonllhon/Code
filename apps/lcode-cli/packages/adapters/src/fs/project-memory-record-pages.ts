import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { z } from "zod";
import { memoryError, readMemoryBytes, strictAtomicWrite } from "./project-memory-io.js";
import { assertMemoryRoot, samePath, type MemoryRoot } from "./project-memory-paths.js";

const PAGE_BYTES = 256 * 1024;
export function memoryRecordFitsPage(record: unknown): boolean {
  let bytes = 0;
  const visit = (value: unknown): void => {
    if (bytes > PAGE_BYTES) return;
    if (typeof value === "string") bytes += Buffer.byteLength(value) * 6 + 2;
    else if (Array.isArray(value)) {
      bytes += value.length + 2;
      for (const child of value) visit(child);
    } else if (value && typeof value === "object") {
      bytes += Object.keys(value).length + 2;
      for (const [key, child] of Object.entries(value)) {
        visit(key);
        visit(child);
      }
    } else bytes += 32;
  };
  visit(record);
  return bytes <= PAGE_BYTES;
}
const Envelope = z
  .object({
    format: z.literal("lcode-record-pages-v1"),
    rootDir: z.string(),
    key: z.string().regex(/^[a-f0-9]{64}$/u),
    count: z.number().int().positive(),
    hash: z.string().regex(/^[a-f0-9]{64}$/u),
    reviewHeader: z
      .object({
        id: z.string(),
        createdAt: z.number().int().nonnegative(),
        revision: z.number().int().positive(),
        itemCount: z.number().int().nonnegative(),
        partial: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();
function keyFor(root: MemoryRoot, path: string): string {
  return createHash("sha256").update(relative(root.stateDir, path)).digest("hex");
}
async function validateDirectory(root: MemoryRoot, directory: string): Promise<void> {
  await assertMemoryRoot(root);
  const info = await lstat(directory);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    !samePath(await realpath(directory), directory)
  )
    throw memoryError("invalid_path", directory, "Memory record page directory changed");
}

/** 长提案正文使用流式 JSON 编码和固定字节页；主记录仅包含固定大小的索引与摘要。 */
export async function writePagedMemoryRecord(
  root: MemoryRoot,
  path: string,
  record: unknown,
  expectedMissing: boolean,
): Promise<void> {
  const key = keyFor(root, path);
  const directory = join(root.stateDir, "record-pages", key);
  await validateDirectory(root, dirname(directory));
  await mkdir(directory, { mode: 0o700 });
  const digest = createHash("sha256");
  let page = Buffer.alloc(0);
  let count = 0;
  for await (const chunk of encodeJson(record)) {
    digest.update(chunk);
    let rest = chunk;
    while (rest.length) {
      const length = Math.min(PAGE_BYTES - page.length, rest.length);
      page = Buffer.concat([page, rest.subarray(0, length)]);
      rest = rest.subarray(length);
      if (page.length === PAGE_BYTES) {
        await strictAtomicWrite(join(directory, `${count++}.bin`), page, {
          expectedMissing: true,
          mode: 0o600,
          validate: () => validateDirectory(root, directory),
        });
        page = Buffer.alloc(0);
      }
    }
  }
  if (page.length)
    await strictAtomicWrite(join(directory, `${count++}.bin`), page, {
      expectedMissing: true,
      mode: 0o600,
      validate: () => validateDirectory(root, directory),
    });
  await strictAtomicWrite(
    path,
    Buffer.from(
      JSON.stringify({
        format: "lcode-record-pages-v1",
        rootDir: root.rootDir,
        key,
        count,
        hash: digest.digest("hex"),
        reviewHeader: reviewHeader(record),
      }),
    ),
    { expectedMissing, mode: 0o600, validate: () => assertMemoryRoot(root) },
  );
}

function reviewHeader(record: unknown) {
  const review = (
    record as {
      review?: {
        id: string;
        createdAt: number;
        revision: number;
        draft: { items: unknown[]; partial: boolean };
      };
    }
  ).review;
  return review
    ? {
        id: review.id,
        createdAt: review.createdAt,
        revision: review.revision,
        itemCount: review.draft.items.length,
        partial: review.draft.partial,
      }
    : undefined;
}

export function readMemoryRecordHeader(root: MemoryRoot, path: string, primary: Buffer) {
  const value: unknown = JSON.parse(primary.toString("utf8"));
  if (!value || typeof value !== "object" || !("format" in value)) return undefined;
  const envelope = Envelope.parse(value);
  if (!samePath(envelope.rootDir, root.rootDir) || envelope.key !== keyFor(root, path))
    throw memoryError("invalid_path", path, "Memory record belongs to another owner");
  return envelope.reviewHeader;
}

export async function readPagedMemoryRecord(
  root: MemoryRoot,
  path: string,
  primary: Buffer,
): Promise<unknown> {
  const value: unknown = JSON.parse(primary.toString("utf8"));
  if (!value || typeof value !== "object" || !("format" in value)) return value;
  const envelope = Envelope.parse(value);
  if (!samePath(envelope.rootDir, root.rootDir) || envelope.key !== keyFor(root, path))
    throw memoryError("invalid_path", path, "Memory record belongs to another owner");
  const directory = join(root.stateDir, "record-pages", envelope.key);
  await validateDirectory(root, directory);
  const digest = createHash("sha256");
  // 单次调用只还原一个已请求的提案；列表与容量检查不合并全部正文到一个 JSON。
  const chunks: Buffer[] = [];
  for (let i = 0; i < envelope.count; i++) {
    const bytes = await readMemoryBytes(join(directory, `${i}.bin`), PAGE_BYTES);
    digest.update(bytes!);
    chunks.push(bytes!);
  }
  if (digest.digest("hex") !== envelope.hash)
    throw memoryError("stale_write", path, "Memory record pages changed");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function* encodeJson(value: unknown): AsyncGenerator<Buffer> {
  if (typeof value === "string") {
    yield Buffer.from('"');
    const characters = 4096;
    for (let i = 0; i < value.length; i += characters)
      yield Buffer.from(JSON.stringify(value.slice(i, i + characters)).slice(1, -1));
    yield Buffer.from('"');
  } else if (Array.isArray(value)) {
    yield Buffer.from("[");
    for (let i = 0; i < value.length; i++) {
      if (i) yield Buffer.from(",");
      yield* encodeJson(value[i] ?? null);
    }
    yield Buffer.from("]");
  } else if (value && typeof value === "object") {
    yield Buffer.from("{");
    let first = true;
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      if (!first) yield Buffer.from(",");
      first = false;
      yield Buffer.from(`${JSON.stringify(key)}:`);
      yield* encodeJson(entry);
    }
    yield Buffer.from("}");
  } else yield Buffer.from(JSON.stringify(value));
}
