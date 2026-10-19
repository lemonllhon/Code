import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ProjectMemoryHistoryPageInputSchema,
  type ProjectMemoryPort,
  type ProjectMemoryChange,
} from "@lcode/contracts";
import type { MemoryStore } from "./project-memory-store.js";
import type { MemoryReviewHeader } from "./project-memory-review-headers.js";
import { memoryError } from "./project-memory-io.js";
import { throwIfAborted } from "./file-system-common.js";

const Cursor = z
  .object({
    scope: z.string(),
    kind: z.enum(["changes", "reviews"]),
    createdAt: z.number().int().nonnegative(),
    id: z.string(),
  })
  .strict();
const compare = (a: { createdAt: number; id: string }, b: { createdAt: number; id: string }) =>
  b.createdAt - a.createdAt || a.id.localeCompare(b.id);

export async function readMemoryHistoryPage(
  store: MemoryStore,
  changes: ProjectMemoryChange[],
  raw: Parameters<NonNullable<ProjectMemoryPort["listHistoryPage"]>>[0],
  signal?: AbortSignal,
): ReturnType<NonNullable<ProjectMemoryPort["listHistoryPage"]>> {
  const input = ProjectMemoryHistoryPageInputSchema.parse(raw);
  const scope = createHash("sha256").update(store.root.rootDir).digest("hex");
  const cursor = input.cursor
    ? Cursor.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")))
    : undefined;
  if (cursor && (cursor.scope !== scope || cursor.kind !== input.kind))
    throw memoryError(
      "invalid_path",
      store.root.rootDir,
      "History cursor belongs to another scope",
    );
  const limit = input.limit ?? 20;
  // 同一 root writer 内枚举元数据；仅保留一页候选，不复制历史正文。
  const selected: (MemoryReviewHeader | ProjectMemoryChange)[] = [];
  const records = input.kind === "reviews" ? store.reviewHeaders(signal) : changes;
  for await (const record of records) {
    throwIfAborted(signal);
    if (cursor && compare(record, cursor) <= 0) continue;
    selected.push(record);
    selected.sort(compare);
    if (selected.length > limit + 1) selected.pop();
  }
  const more = selected.length > limit;
  const page = selected.slice(0, limit);
  const last = page.at(-1);
  const nextCursor =
    more && last
      ? Buffer.from(
          JSON.stringify({ scope, kind: input.kind, createdAt: last.createdAt, id: last.id }),
        ).toString("base64url")
      : undefined;
  if (input.kind === "changes")
    return { kind: "changes", changes: page as ProjectMemoryChange[], nextCursor };
  return {
    kind: "reviews",
    nextCursor,
    proposals: (page as MemoryReviewHeader[]).map((header) => {
      const applied = new Set<string>();
      for (const change of changes) {
        if (
          change.proposalId !== header.id ||
          change.status !== "committed" ||
          !change.proposalItemId
        )
          continue;
        if (applied.has(change.proposalItemId))
          throw memoryError("io_error", header.id, "Duplicate proposal application");
        applied.add(change.proposalItemId);
      }
      return {
        ...header,
        appliedCount: applied.size,
        summary: `Reviewed ${header.itemCount} candidates; applied ${applied.size}.`,
      };
    }),
  };
}
