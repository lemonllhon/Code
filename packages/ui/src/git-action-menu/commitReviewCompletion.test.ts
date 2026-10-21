import test from "node:test";
import assert from "node:assert/strict";
import { createGitReviewWorkspaceSnapshot, type GitCommitReview } from "@lcode/shared";
import { commitReviewCompletionPatch } from "./commitReviewCompletion.js";

test("提交完成、分组推进和 warning 使用一个补丁，warning 不清空人工草稿", () => {
  const data = createGitReviewWorkspaceSnapshot({ workspacePath: "/fixture", scopeId: "a" }).data;
  data.draft.message = "人工提交信息";
  data.draft.edited = true;
  data.sourceReview = { id: "review" };
  data.selectedPaths = ["a.ts"];
  data.excludedFiles = ["b.ts"];
  const review: GitCommitReview = {
    id: "review",
    mode: "ordered",
    warnings: [],
    groups: ["first", "next"].map((message) => ({
      id: message,
      message,
      label: message,
      sessionIds: [],
      dependsOn: [],
      requiresConfirmation: true,
      files: [],
    })),
  };
  const next = commitReviewCompletionPatch(data, review, 1);
  assert.equal(next.draft?.message, "next");
  assert.equal(next.browsePosition, 1);
  assert.deepEqual(next.sourceReview, { id: "review" });
  assert.equal(next.selectedPaths, undefined);
  const final = commitReviewCompletionPatch(data, review, 2);
  assert.equal(final.draft?.message, "");
  assert.equal(final.draft?.requiresRegeneration, false);
  assert.equal(final.sourceReview, null);
  assert.equal(final.selectedPaths, null);
  assert.deepEqual(final.excludedFiles, []);
  assert.equal(final.includeUnstaged, true);
  const warning = commitReviewCompletionPatch(data, review, 2, "warning");
  assert.equal(warning.draft?.message, "人工提交信息");
  assert.equal(warning.draft?.requiresRegeneration, true);
  assert.deepEqual(warning.sourceReview, { id: "review" });
  assert.equal(warning.selectedPaths, undefined);
  assert.deepEqual(data.selectedPaths, ["a.ts"]);
});
