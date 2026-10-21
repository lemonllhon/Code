import assert from "node:assert/strict";
import test from "node:test";
import { historyTree } from "./gitHistoryTree.js";
test("目录优先，文件/目录转换保留两个节点，中文状态与数量不丢失", () => {
  const tree = historyTree([
    { path: "foo", status: "D" },
    { path: "foo/中文.ts", status: "A" },
    { path: "z.ts", status: "M" },
  ]);
  assert.equal(tree[0]!.key, "d:foo");
  assert.equal(tree[0]!.count, 1);
  assert.equal(tree[0]!.children[0]!.path, "foo/中文.ts");
  assert.equal(tree[1]!.key, "f:foo");
  assert.equal(tree[1]!.status, "D");
});
