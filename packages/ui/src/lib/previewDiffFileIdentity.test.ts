import assert from "node:assert/strict";
import test from "node:test";
import { createPreviewDiffFiles } from "./previewDiffFileIdentity.js";

test("等长且首尾相同的中段修改不能复用旧 Diff AST", () => {
  const a = "x".repeat(100) + "middle-one" + "y".repeat(100);
  const b = "x".repeat(100) + "middle-two" + "y".repeat(100);
  const source = { title: "fixture.ts", beforeContent: a, afterContent: a };
  const initial = createPreviewDiffFiles(source);
  const changed = createPreviewDiffFiles({ ...source, afterContent: b });
  assert.equal(changed.oldFile.cacheKey, initial.oldFile.cacheKey);
  assert.notEqual(changed.newFile.cacheKey, initial.newFile.cacheKey);
  assert.notEqual(changed.oldFile.cacheKey, changed.newFile.cacheKey);
  assert.equal(changed.newFile.contents, b);
  assert.notEqual(
    createPreviewDiffFiles({ ...source, path: "other.ts" }).oldFile.cacheKey,
    initial.oldFile.cacheKey,
  );
});
