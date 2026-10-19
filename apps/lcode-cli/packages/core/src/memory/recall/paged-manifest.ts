import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  FileSystemListDirectoryRequest,
  FileSystemPort,
  TraceContext,
} from "@lcode/contracts";
import type { MemoryCandidateScanResult } from "./types.js";

const DIRECTORY_PAGE = 256;
export async function scanPagedMemoryPaths(input: {
  fileSystem: FileSystemPort;
  rootDir: string;
  signal?: AbortSignal;
  traceContext?: TraceContext;
}): Promise<MemoryCandidateScanResult> {
  const paths: string[] = [];
  const directories = [input.rootDir];
  const seen = new Set([resolve(input.rootDir)]);
  const scan = {
    complete: false,
    truncated: false,
    rejected: 0,
    failedDirectories: 0,
    scannedDirectories: 0,
    processedEntries: 0,
    unknownDirectories: 0,
  };
  for (const directory of directories) {
    scan.scannedDirectories++;
    let page: FileSystemListDirectoryRequest["page"] = {};
    try {
      do {
        input.signal?.throwIfAborted();
        const result = await input.fileSystem.listDirectory(
          { path: directory, limit: DIRECTORY_PAGE, page, trace: input.traceContext },
          { signal: input.signal },
        );
        if (result.truncated && !result.nextPage) {
          scan.truncated = true;
          break;
        }
        for (const entry of result.entries) {
          scan.processedEntries++;
          const child = relative(directory, entry.path);
          if (
            !child ||
            child === ".." ||
            isAbsolute(child) ||
            child.includes(sep) ||
            entry.path !== resolve(directory, entry.name) ||
            seen.has(resolve(entry.path))
          ) {
            scan.rejected++;
            continue;
          }
          seen.add(resolve(entry.path));
          if (entry.kind === "directory") directories.push(entry.path);
          else if (
            entry.kind === "file" &&
            entry.name.endsWith(".md") &&
            basename(entry.name) !== "MEMORY.md"
          )
            paths.push(entry.path);
          else scan.rejected++;
        }
        if (page?.afterName && result.nextPage && result.nextPage.afterName <= page.afterName)
          throw new Error("Memory directory cursor did not advance");
        page = result.nextPage;
      } while (page);
    } catch (error) {
      input.signal?.throwIfAborted();
      scan.failedDirectories++;
      if (error instanceof Error && error.name === "AbortError") throw error;
    }
  }
  scan.complete = !scan.truncated && scan.failedDirectories === 0;
  return { paths, scan };
}
