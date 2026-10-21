import { test } from "node:test";
import assert from "node:assert/strict";
import type { GitFileChange } from "@lcode/shared";
import { buildGitBranchCommitPreviewFiles } from "../git-branch-switcher/display.js";
import {
  buildReviewFileTree,
  reviewTreePaths,
  reviewTreeCheckState,
} from "./reviewFileTreeModel.js";

test("未跟踪分组保留服务事实，不能把所有 added 文件当作未跟踪", () => {
  const file = (path: string, isUntracked: boolean) =>
    ({
      path,
      repoRelativePath: path,
      workspaceRelativePath: path,
      kind: "added",
      added: 1,
      removed: 0,
      isUntracked,
    }) as GitFileChange;
  const files = buildGitBranchCommitPreviewFiles([file("new.ts", true), file("staged.ts", false)]);
  assert.deepEqual(
    files.filter((file) => file.isUntracked).map((file) => file.repoRelativePath),
    ["new.ts"],
  );
});

test("目录按当前页构建，跟踪与未跟踪分组，同路径版本保留两个叶节点", () => {
  const files = [
    { path: "src/a.ts", staged: true },
    { path: "src/a.ts", staged: false },
    { path: "src/new.ts" },
    { path: "README.md" },
  ];
  const groups = buildReviewFileTree(files, new Set(["src/new.ts"]));
  assert.equal(groups.length, 2);
  assert.equal(groups[0]!.children[0]!.label, "src");
  assert.equal(groups[0]!.children[0]!.children.length, 2);
  assert.deepEqual(reviewTreePaths(groups[0]!), ["src/a.ts", "README.md"]);
  assert.deepEqual(reviewTreePaths(groups[1]!), ["src/new.ts"]);
});

test("三态来自唯一包含范围；批量仅取该节点所含当前页路径", () => {
  const [group] = buildReviewFileTree([{ path: "src/a.ts" }, { path: "src/b.ts" }]);
  assert.equal(reviewTreeCheckState(group!, new Set()), true);
  assert.equal(reviewTreeCheckState(group!, new Set(["src/a.ts"])), "indeterminate");
  assert.equal(reviewTreeCheckState(group!, new Set(["src/a.ts", "src/b.ts"])), false);
  assert.deepEqual(reviewTreePaths(group!), ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(buildReviewFileTree([]), []);
});
