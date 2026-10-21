import assert from "node:assert/strict";
import test from "node:test";
import { parseGitPublishIndex } from "./gitPublishIndex.js";

const oid = "a".repeat(40);
function record(path: string, flags = "0", stage = "0", mode = "100644") {
  return `H ${mode} ${oid} ${stage}\t${path}\0  ctime: 1:2\n  mtime: 3:4\n  dev: 5\tino: 6\n  uid: 7\tgid: 8\n  size: 9\tflags: ${flags}\n`;
}

test("NUL paths retain spaces, tabs, newlines and non-ASCII text", () => {
  const paths = ["目录/空 格.ts", "tab\tname.ts", "line\nbreak.ts"];
  const parsed = parseGitPublishIndex(paths.map((path) => record(path)).join(""));
  assert.deepEqual(parsed.paths, paths);
  assert.equal(parsed.entries.length, paths.length);
  assert.notDeepEqual(
    parseGitPublishIndex(record("a\nb")),
    parseGitPublishIndex(record("a") + record("b")),
  );
});

test("cache stat and in-memory flags do not change logical approval; persistent flags do", () => {
  const base = record("a.txt");
  const expected = parseGitPublishIndex(base);
  const changedCache = base.replace("ctime: 1:2", "ctime: 100:200").replace("size: 9", "size: 0");
  for (const flags of ["0", "40000", "200000", "8000000"])
    assert.deepEqual(
      parseGitPublishIndex(changedCache.replace("flags: 0", `flags: ${flags}`)),
      expected,
    );
  for (const flags of ["8000", "20004000", "40004000"])
    assert.notDeepEqual(parseGitPublishIndex(record("a.txt", flags)), expected);
  assert.notDeepEqual(parseGitPublishIndex(record("a.txt", "0", "0", "100755")), expected);
  assert.notDeepEqual(parseGitPublishIndex(base.replace(oid, "b".repeat(40))), expected);
});

test("conflicts, submodules, reserved persistent flags and incomplete records reject", () => {
  for (const output of [
    record("a.txt", "0", "1"),
    record("submodule", "0", "0", "160000"),
    record("a.txt", "80000000"),
    record("a.txt").replace("ctime:", "future:"),
    record("a.txt").replace("flags: 0", "flags: nope"),
    record("a.txt").replace(oid, "a".repeat(41)),
    record("a.txt").slice(0, -1),
    record("a.txt") + "tail",
  ])
    assert.throws(() => parseGitPublishIndex(output), /暂存区|格式|子模块/);
  assert.deepEqual(parseGitPublishIndex(""), { entries: [], paths: [] });
});
