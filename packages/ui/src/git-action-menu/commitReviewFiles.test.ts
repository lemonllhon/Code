import assert from "node:assert/strict";
import test from "node:test";
import type { GitCommitReview } from "@lcode/shared";
import type { GitCommitDialogState } from "./commitDialogModel.js";
import { commitReviewFiles, reviewPreviewFileKey } from "./commitReviewFiles.js";

test("同一路径的 index 与 working 版本不被去重覆盖，空范围不回退全仓", () => {
  const file = { repoRelativePath: "a.ts", added: 1, removed: 0 };
  const state = { unstagedFiles: [file], stagedFiles: [file] } as GitCommitDialogState;
  const files = commitReviewFiles(state, null, 0);
  assert.equal(files.length, 2);
  assert.notEqual(reviewPreviewFileKey(files[0]!), reviewPreviewFileKey(files[1]!));
  assert.deepEqual(commitReviewFiles(null, null, 0), []);
});
test("冻结与历史审核始终用对应组原始 patch，不回读 working tree", () => {
  const files = [{ path: "a.ts", patch: "frozen", added: 1, removed: 0 }];
  const review = { groups: [{ files: [] }, { files }] } as unknown as GitCommitReview;
  assert.equal(commitReviewFiles(null, review, 1), files);
  assert.deepEqual(commitReviewFiles(null, review, 0), []);
});
