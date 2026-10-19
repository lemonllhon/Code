import type { ProjectMemoryChange, ProjectMemoryReview } from "@lcode/contracts";
import { memoryError } from "./project-memory-io.js";

export function projectReview(
  review: ProjectMemoryReview,
  changes: readonly ProjectMemoryChange[],
): ProjectMemoryReview {
  const appliedItems = new Map<string, string>();
  for (const change of changes) {
    if (change.proposalId !== review.id || change.status !== "committed" || !change.proposalItemId)
      continue;
    if (appliedItems.has(change.proposalItemId))
      throw memoryError(
        "io_error",
        review.id,
        "Duplicate committed Project Memory proposal application",
      );
    appliedItems.set(change.proposalItemId, change.id);
  }
  return { ...review, appliedItems: Object.fromEntries(appliedItems) };
}
