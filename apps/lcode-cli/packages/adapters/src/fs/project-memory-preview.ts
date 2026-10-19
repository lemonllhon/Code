import type {
  ProjectMemoryChange,
  ProjectMemoryOperationOptions,
  ProjectMemoryPort,
} from "@lcode/contracts";
import type { MemoryJournal } from "./project-memory-journal.js";
import { readMemoryContentFilePage } from "./project-memory-content.js";

type Preview = Awaited<ReturnType<ProjectMemoryPort["previewUndo"]>>;
type WithMemory = (
  run: (state: { journal: MemoryJournal; changes: ProjectMemoryChange[] }) => Promise<Preview>,
) => Promise<Preview>;
export function previewProjectMemoryUndo(
  input: Parameters<ProjectMemoryPort["previewUndo"]>[0],
  withMemory: WithMemory,
  options?: ProjectMemoryOperationOptions,
): Promise<Preview> {
  return withMemory(async ({ journal, changes }) => {
    const { change, before } = await journal.replaceForUndo(input.changeId, changes);
    const page = await readMemoryContentFilePage(
      before.path,
      { offset: input.offset, maxBytes: input.maxBytes ?? 64 * 1024, expectedHash: before.hash },
      options,
    );
    return {
      change,
      content: page.content,
      ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}),
    };
  });
}
