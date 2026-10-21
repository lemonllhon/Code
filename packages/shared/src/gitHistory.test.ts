import assert from "node:assert/strict";
import test from "node:test";
import {
  gitHistoryRequestSchema,
  gitHistoryFileRequestSchema,
  gitHistoryTagOptionsSchema,
} from "./gitHistory.js";
import { gitHistoryLocateRequestSchema } from "./gitHistory.js";
import { gitHistoryResetOptionsSchema, gitHistoryResetRequestSchema } from "./gitHistoryReset.js";
import { gitIntegrationPreviewRequestSchema } from "./gitIntegration.js";
test("定位、正则、批次与 Reset 使用严格有界合同", () => {
  const scope = { workspacePath: "/repo" },
    hash = "a".repeat(40);
  assert.ok(gitHistoryLocateRequestSchema.safeParse({ ...scope, target: "HEAD" }).success);
  for (const target of ["--all", "HEAD~1", "a^{commit}", "abc"])
    assert.equal(gitHistoryLocateRequestSchema.safeParse({ ...scope, target }).success, false);
  const request = { ...scope, mode: "cherry-pick", targetRef: hash };
  for (const targets of [
    [],
    [hash, hash],
    Array.from({ length: 33 }, (_, i) => i.toString(16).padStart(40, "0")),
  ])
    assert.equal(
      gitIntegrationPreviewRequestSchema.safeParse({ ...request, targets }).success,
      false,
    );
  assert.equal(
    gitIntegrationPreviewRequestSchema.safeParse({ ...request, mainline: 0 }).success,
    false,
  );
  assert.equal(
    gitHistoryResetOptionsSchema.safeParse({ ...scope, target: hash, mode: "--hard" }).success,
    false,
  );
  assert.equal(
    gitHistoryResetRequestSchema.safeParse({
      ...scope,
      requestId: "x",
      allowReservationKey: "bypass",
    }).success,
    false,
  );
});
test("历史请求字面筛选、严格分页/路径/Tag 参数，不接受 writer bypass", () => {
  const scope = { workspacePath: "/repo" };
  assert.ok(
    gitHistoryRequestSchema.safeParse({ ...scope, author: "[name]", search: "--all", limit: 50 })
      .success,
  );
  assert.equal(gitHistoryRequestSchema.safeParse({ ...scope, skip: 50 }).success, false);
  assert.equal(gitHistoryRequestSchema.safeParse({ ...scope, since: "2026-02-32" }).success, false);
  for (const path of ["../x", "/x", ".git/config", "a/../../x", "a\\b"])
    assert.equal(
      gitHistoryFileRequestSchema.safeParse({ ...scope, hash: "a".repeat(40), path }).success,
      false,
    );
  for (const name of ["--force", "refs/tags/x", "a..b", "x.lock"])
    assert.equal(
      gitHistoryTagOptionsSchema.safeParse({
        ...scope,
        hash: "a".repeat(40),
        name,
        message: "tag",
        signed: false,
      }).success,
      false,
    );
  assert.equal(
    gitHistoryRequestSchema.safeParse({ ...scope, allowReservationKey: "bypass" }).success,
    false,
  );
});
