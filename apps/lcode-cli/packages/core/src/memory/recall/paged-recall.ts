import { relative, sep } from "node:path";
import { isFileSystemPortError, type FileSystemPort, type TraceContext } from "@lcode/contracts";
import { parseMemoryDocument } from "./document.js";
import { rankMemoryDocuments } from "./ranking.js";
import { tokenizeMemoryRecallText } from "./tokenizer.js";
import type { IndexedMemoryDocument, MemoryCandidateScanStats } from "./types.js";
import { mapWithFixedConcurrency } from "./concurrency.js";
import { MEMORY_RECALL_SCAN_CONCURRENCY } from "./constants.js";

const PAGE_BYTES = 64 * 1024;
const RETAINED_MATCHES = 8;
interface Input {
  fileSystem: FileSystemPort;
  rootDir: string;
  signal?: AbortSignal;
  traceContext?: TraceContext;
}

/** 全语料两遍流式排名，只保留当前查询的一批候选正文；总容量不决定可检索范围。 */
export async function reconcilePagedRecall(
  input: Input,
  paths: readonly string[],
  scan: MemoryCandidateScanStats,
  queryTokens: readonly string[],
  now: number,
) {
  let documentCount = 0;
  let tokenCount = 0;
  let indexedBytes = 0;
  const failedFiles = new Set<string>();
  const expiredFiles = new Set<string>();
  const frequencies = new Map<string, number>();
  await mapWithFixedConcurrency(
    paths,
    MEMORY_RECALL_SCAN_CONCURRENCY,
    async (path) => {
      try {
        let count = 0,
          tokens = 0,
          bytes = 0;
        let expired = false;
        const fileFrequencies = new Map<string, number>();
        for await (const doc of readFilePages(input, path)) {
          if (doc.validUntilMs !== undefined && doc.validUntilMs <= now) {
            expired = true;
            continue;
          }
          count++;
          tokens += doc.tokenCount;
          bytes += doc.indexedBytes;
          for (const term of new Set(queryTokens))
            if (doc.termFrequencies.has(term))
              fileFrequencies.set(term, (fileFrequencies.get(term) ?? 0) + 1);
        }
        // 文件完整流和 revision 验证结束后才收录，不能累计失败文件的半份统计。
        // 分页后仍按文件统计过期状态；不能在生成器提前返回而把过期文件漏记成零。
        if (expired) expiredFiles.add(path);
        documentCount += count;
        tokenCount += tokens;
        indexedBytes += bytes;
        for (const [term, count] of fileFrequencies)
          frequencies.set(term, (frequencies.get(term) ?? 0) + count);
      } catch {
        input.signal?.throwIfAborted();
        failedFiles.add(path);
      }
    },
    input.signal,
  );
  const corpus = {
    documentCount,
    averageDocumentLength: Math.max(1, tokenCount / Math.max(1, documentCount)),
    documentFrequencies: frequencies,
  };
  let top: IndexedMemoryDocument[] = [];
  await mapWithFixedConcurrency(
    paths,
    MEMORY_RECALL_SCAN_CONCURRENCY,
    async (path) => {
      try {
        let localTop: IndexedMemoryDocument[] = [];
        for await (const doc of readFilePages(input, path)) {
          if (doc.validUntilMs !== undefined && doc.validUntilMs <= now) {
            continue;
          }
          localTop = rankMemoryDocuments({ documents: [...localTop, doc], queryTokens, corpus })
            .slice(0, RETAINED_MATCHES)
            .map((entry) => entry.document);
        }
        top = rankMemoryDocuments({ documents: [...top, ...localTop], queryTokens, corpus })
          .slice(0, RETAINED_MATCHES)
          .map((entry) => entry.document);
      } catch {
        input.signal?.throwIfAborted();
        failedFiles.add(path);
      }
    },
    input.signal,
  );
  return {
    candidateCount: paths.length,
    documents: new Map(top.map((doc) => [`${doc.filePath}:${doc.byteOffset ?? 0}`, doc])),
    indexedCount: documentCount,
    corpus,
    health: {
      scanLimited: !scan.complete,
      failedFileCount: failedFiles.size,
      expiredCount: expiredFiles.size,
      truncatedFileCount: 0,
      indexedBytes,
    },
    scan,
  };
}

async function* readFilePages(input: Input, path: string): AsyncGenerator<IndexedMemoryDocument> {
  const fileName = relative(input.rootDir, path).split(sep).join("/");
  let offset: number | undefined = 0;
  let hash: string | undefined;
  let metadata: ReturnType<typeof parseMemoryDocument> | undefined;
  let carry = "";
  for await (const page of contentPages(input, path, fileName)) {
    input.signal?.throwIfAborted();
    if (
      page.offset !== offset ||
      page.bytesRead > PAGE_BYTES ||
      (page.nextOffset !== undefined && page.nextOffset <= offset)
    )
      throw new Error("Invalid memory content cursor");
    hash ??= page.hash;
    if (hash !== page.hash) throw new Error("Memory changed during recall");
    metadata ??= parseMemoryDocument(page.content);
    // 相邻页重叠少量上下文，避免词或中文 bigram 恰好跨页而不可检索。
    // body 解析会归一 CRLF 并移除 frontmatter；页游标必须仍按原字节定位。
    const prefix = offset ? 0 : rawMemoryBodyStart(page.content, metadata.body);
    const content = carry + page.content.slice(prefix);
    const tokens = tokenizeMemoryRecallText(content);
    const termFrequencies = new Map<string, number>();
    for (const token of tokens) termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + 1);
    const byteOffset = Math.max(
      0,
      offset + Buffer.byteLength(page.content.slice(0, prefix)) - Buffer.byteLength(carry),
    );
    yield {
      content,
      byteOffset,
      filePath: path,
      filename: fileName,
      indexedBytes: page.bytesRead,
      metadataTokens: new Set(
        tokenizeMemoryRecallText(
          [fileName, metadata.description, metadata.type].filter(Boolean).join(" "),
        ),
      ),
      mtimeMs: 0,
      sourceHash: hash,
      tokenCount: tokens.length,
      termFrequencies,
      truncated: false,
      ...(metadata.description ? { description: metadata.description } : {}),
      ...(metadata.type ? { type: metadata.type } : {}),
      ...(metadata.validUntilMs !== undefined ? { validUntilMs: metadata.validUntilMs } : {}),
    };
    carry = Array.from(page.content).slice(-128).join("");
    offset = page.nextOffset;
  }
}

async function* contentPages(input: Input, path: string, fileName: string) {
  const memory = input.fileSystem.projectMemory!;
  if (memory.iterateContentPages) {
    let emitted = false;
    try {
      for await (const page of memory.iterateContentPages(
        { rootDir: input.rootDir, fileName, maxBytes: PAGE_BYTES },
        { signal: input.signal, trace: input.traceContext },
      )) {
        emitted = true;
        yield page;
      }
      return;
    } catch (error) {
      if (emitted || !isFileSystemPortError(error) || error.code !== "unsupported") throw error;
    }
  }
  let offset: number | undefined = 0,
    hash: string | undefined;
  do {
    const page = await readRecallPage(input, path, fileName, offset, hash);
    hash ??= page.hash;
    offset = page.nextOffset;
    yield page;
  } while (offset !== undefined);
}

function rawMemoryBodyStart(raw: string, body: string): number {
  const normalized = raw.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
  const prefix = normalized.length - body.length;
  let index = raw.startsWith("\uFEFF") ? 1 : 0;
  for (let count = 0; count < prefix; count++, index++)
    if (raw[index] === "\r" && raw[index + 1] === "\n") index++;
  return index;
}

async function readRecallPage(
  input: Input,
  path: string,
  fileName: string,
  offset: number,
  hash?: string,
) {
  try {
    return await input.fileSystem.projectMemory!.readContentPage!(
      { rootDir: input.rootDir, fileName, offset, maxBytes: PAGE_BYTES, expectedHash: hash },
      { signal: input.signal, trace: input.traceContext },
    );
  } catch (error) {
    // 旧编码保留原文本端口的完整读取兼容；不能把乱码字节页当成可审核的 UTF-8 正文。
    if (!isFileSystemPortError(error) || error.code !== "unsupported" || offset !== 0) throw error;
    const read = await input.fileSystem.readTextFile(
      { path, maxBytes: PAGE_BYTES, trace: input.traceContext },
      { signal: input.signal },
    );
    if (read.truncated || read.bytesRead !== read.sizeBytes || !read.revision?.hash) throw error;
    return {
      content: read.content,
      offset: 0,
      bytesRead: read.bytesRead,
      sizeBytes: read.sizeBytes,
      hash: read.revision.hash,
      nextOffset: undefined,
    };
  }
}
