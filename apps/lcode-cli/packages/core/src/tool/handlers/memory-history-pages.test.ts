import assert from "node:assert/strict";
import test from "node:test";
import { memoryReviewToolEntry } from "./memory.js";
import { memoryHistoryToolEntry } from "./memory-history.js";
import { reviewHarness } from "../../memory/review-test-fixtures.js";

test("history tools pass opaque continuation to the original owner and return bounded pages", async () => {
  const h = reviewHarness();
  const calls: unknown[] = [];
  h.context.fileSystemPort!.projectMemory = {} as never;
  h.context.fileSystemPort!.projectMemory!.listHistoryPage = async (input) => {
    calls.push(input);
    return input.kind === "reviews"
      ? { kind: "reviews", proposals: [], nextCursor: "next-review" }
      : { kind: "changes", changes: [], nextCursor: "next-change" };
  };
  h.context.fileSystemPort!.projectMemory!.listReviews = async () => {
    throw new Error("Cannot materialize all proposals");
  };
  h.context.fileSystemPort!.projectMemory!.listChanges = async () => {
    throw new Error("Cannot return all history");
  };
  assert.deepEqual(
    await memoryReviewToolEntry.handler({ action: "list", cursor: "review-cursor" }, h.context),
    { status: "list", proposals: [], nextCursor: "next-review" },
  );
  assert.deepEqual(
    await memoryHistoryToolEntry.handler({ action: "list", cursor: "change-cursor" }, h.context),
    { status: "list", changes: [], nextCursor: "next-change" },
  );
  assert.deepEqual(calls, [
    { rootDir: h.context.memoryRoot, kind: "reviews", cursor: "review-cursor" },
    { rootDir: h.context.memoryRoot, kind: "changes", cursor: "change-cursor" },
  ]);
});
