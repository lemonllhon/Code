import assert from "node:assert/strict";
import test from "node:test";
import {
  gitIntegrationPreviewRequestSchema,
  gitIntegrationActionRequestSchema,
} from "./gitIntegration.js";

test("整合目标只接受完整 ref/提交，拒绝参数、revision 表达式和 RPC bypass", () => {
  const scope = { workspacePath: "/repo", mode: "merge" };
  for (const targetRef of [
    "refs/heads/feature/a",
    "refs/remotes/origin/main",
    "refs/tags/v1",
    "a".repeat(40),
  ])
    assert.ok(gitIntegrationPreviewRequestSchema.safeParse({ ...scope, targetRef }).success);
  for (const targetRef of [
    "--abort",
    "main",
    "HEAD~1",
    "refs/heads/a..b",
    "refs/heads/.git/x",
    "refs/heads/x\n",
  ])
    assert.equal(
      gitIntegrationPreviewRequestSchema.safeParse({ ...scope, targetRef }).success,
      false,
    );
  assert.equal(
    gitIntegrationPreviewRequestSchema.safeParse({
      ...scope,
      targetRef: "refs/heads/main",
      mode: "shared",
    }).success,
    false,
  );
  const action = {
    workspacePath: "/repo",
    requestId: "next",
    sourceRequestId: "original",
    expectedRevision: "b".repeat(64),
    confirmNativeStopped: false,
    confirmDiscard: false,
  };
  assert.ok(gitIntegrationActionRequestSchema.safeParse(action).success);
  for (const field of ["allowReservationKey", "ownerId", "mode"])
    assert.equal(
      gitIntegrationActionRequestSchema.safeParse({ ...action, [field]: "bypass" }).success,
      false,
    );
});
