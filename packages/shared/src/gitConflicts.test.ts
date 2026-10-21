import assert from "node:assert/strict";
import test from "node:test";
import {
  gitConflictFileRequestSchema,
  gitSaveConflictRequestSchema,
  gitMarkConflictRequestSchema,
  gitConflictVersionSchema,
} from "./gitConflicts.js";
const command = {
  workspacePath: "/fixture",
  path: "src/中文-[x].ts",
  sourceRequestId: "owner",
  requestId: "request",
  expectedRevision: "a".repeat(64),
  confirmNativeStopped: false,
};
test("人工解决 RPC 拒绝越界、模糊目标、命令选项和 Host-only bypass", () => {
  assert.equal(
    gitConflictFileRequestSchema.safeParse({ workspacePath: "/fixture", path: command.path })
      .success,
    true,
  );
  for (const path of [
    "../escape",
    "/absolute",
    "C:/escape",
    ".git/config",
    "a/../b",
    "a//b",
    "a\\b",
    "bad\0name",
    "bad\ufffdname",
  ])
    assert.equal(
      gitConflictFileRequestSchema.safeParse({ workspacePath: "/fixture", path }).success,
      false,
    );
  for (const extra of [
    { resource: "checkout" },
    { allowReservationKey: "a".repeat(64) },
    { ownerId: "agent" },
    { force: true },
  ])
    assert.equal(
      gitSaveConflictRequestSchema.safeParse({
        ...command,
        action: "save",
        text: "result",
        ...extra,
      }).success,
      false,
    );
});
test("保存与删除合同分离，标记与进程核对无默认授权", () => {
  assert.equal(
    gitSaveConflictRequestSchema.safeParse({ ...command, action: "save", text: "" }).success,
    true,
  );
  assert.equal(
    gitSaveConflictRequestSchema.safeParse({ ...command, action: "save" }).success,
    false,
  );
  assert.equal(
    gitSaveConflictRequestSchema.safeParse({ ...command, action: "delete", text: "wrong" }).success,
    false,
  );
  assert.equal(
    gitSaveConflictRequestSchema.safeParse({ ...command, action: "save", text: "a\0b" }).success,
    false,
  );
  assert.equal(
    gitMarkConflictRequestSchema.safeParse({ ...command, confirmSpecial: false }).success,
    true,
  );
  assert.equal(gitMarkConflictRequestSchema.safeParse(command).success, false);
  assert.equal(
    gitConflictVersionSchema.safeParse({
      kind: "symlink",
      oid: "HEAD",
      mode: "120000",
      size: 3,
      text: null,
      eol: "none",
    }).success,
    false,
  );
});
