import { isAbsolute, relative, resolve, sep } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { ReadMemoryReviewEvidenceInput } from "@lcode/contracts";
import { NON_REASONING, PART_TYPE, TOOL_NAME } from "./memory-evidence-selection.js";

/** 仅已完成的实际 Write/Edit 才能隔离自动提取；输入路径不能由 stdout 或助手叙述代替。 */
export function hasDirectMemoryWrite(
  db: DatabaseSync,
  scope: ReadMemoryReviewEvidenceInput["memoryScope"],
  range: string,
  args: SQLInputValue[],
): boolean {
  if (!scope) return false;
  const paths = db
    .prepare(`select json_extract(p.data, '$.state.input.file_path') as path
    from message m join part p on p.session_id = m.session_id and p.message_id = m.id
    where ${range} and ${NON_REASONING} and ${PART_TYPE} = 'tool' and ${TOOL_NAME} in ('Write','Edit') and json_extract(p.data, '$.state.status') = 'completed'`)
    .iterate(...args);
  for (const row of paths) {
    if (typeof row.path !== "string" || !row.path) continue;
    const child = relative(scope.rootDir, resolve(scope.workingDirectory, row.path));
    if (child && !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`)) return true;
  }
  return false;
}
