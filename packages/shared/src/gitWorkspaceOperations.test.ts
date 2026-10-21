import assert from "node:assert/strict";
import test from "node:test";
import {
  gitAcquisitionOptionsSchema,
  gitAcquireRepositoryRequestSchema,
  gitStashApplyRequestSchema,
  gitStashSaveRequestSchema,
  gitCompleteOperationRequestSchema,
} from "./gitWorkspaceOperations.js";

test("导入合同限制路径叶子、命令选项、模式与 Host-only 写入参数", () => {
  const base = {
    workspacePath: "/fixture",
    mode: "clone",
    targetName: "repo",
    url: "https://example.invalid/repo.git",
  };
  assert.equal(gitAcquisitionOptionsSchema.safeParse(base).success, true);
  for (const targetName of ["../escape", "a\\b", "NUL", "con.txt", "a.", "a ", "/abs", "a\nb"])
    assert.equal(gitAcquisitionOptionsSchema.safeParse({ ...base, targetName }).success, false);
  for (const extra of [
    { url: "--upload-pack=bad" },
    { initialBranch: "main" },
    { force: true },
    { resource: "repository" },
  ])
    assert.equal(gitAcquisitionOptionsSchema.safeParse({ ...base, ...extra }).success, false);
  assert.equal(
    gitAcquisitionOptionsSchema.safeParse({
      workspacePath: "/fixture",
      mode: "init",
      initialBranch: "main",
      allowNested: true,
    }).success,
    true,
  );
  assert.equal(
    gitAcquireRepositoryRequestSchema.safeParse({
      options: base,
      requestId: "one",
      preview: {
        revision: "a".repeat(64),
        targetPath: "/fixture/repo",
        mode: "clone",
        parentRepository: null,
      },
      allowReservationKey: "a".repeat(64),
    }).success,
    false,
  );
});

test("Stash 只接受完整 OID/状态和显式选项；恢复不能注入 reservation key", () => {
  const state = {
    headCommitHash: "a".repeat(40),
    branchName: "main",
    indexFingerprint: "b".repeat(64),
    worktreeFingerprint: "c".repeat(64),
  };
  const base = {
    workspacePath: "/fixture",
    requestId: "one",
    expectedRevision: "d".repeat(64),
    expectedState: state,
  };
  assert.equal(
    gitStashSaveRequestSchema.safeParse({ ...base, includeUntracked: false, message: "" }).success,
    true,
  );
  assert.equal(gitStashSaveRequestSchema.safeParse({ ...base, message: "" }).success, false);
  for (const oid of ["stash@{0}", "HEAD", "a".repeat(7), "--all"])
    assert.equal(
      gitStashApplyRequestSchema.safeParse({ ...base, oid, restoreIndex: false }).success,
      false,
    );
  assert.equal(
    gitStashApplyRequestSchema.safeParse({
      ...base,
      oid: "a".repeat(40),
      restoreIndex: false,
      pop: true,
    }).success,
    false,
  );
  assert.equal(
    gitCompleteOperationRequestSchema.safeParse({
      workspacePath: "/fixture",
      requestId: "one",
      sourceRequestId: "source",
      expectedRevision: "a".repeat(64),
      confirmNativeStopped: true,
      allowReservationKey: "a".repeat(64),
    }).success,
    false,
  );
});
