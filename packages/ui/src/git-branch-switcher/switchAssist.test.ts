import assert from "node:assert/strict";
import test from "node:test";
import type { IGitService } from "@lcode/services";
import type { GitBranchMutationResult, GitFileChange } from "@lcode/shared";
import { buildGitBranchSwitchAssistState } from "./switchAssist.js";

const result = {
  ok: false,
  action: "switch",
  branchName: "topic",
  didChange: false,
  created: false,
  summary: { branchName: "main", repoRoot: "/repo" },
  issues: [
    { code: "tracked-changes-would-be-overwritten", paths: ["sub/a.ts"], message: "blocked" },
  ],
} as GitBranchMutationResult;
const file = (path: string) =>
  ({
    path: `/repo/${path}`,
    repoRelativePath: path,
    workspaceRelativePath: path.replace(/^sub\//, ""),
    kind: "modified",
    added: 1,
    removed: 0,
  }) as GitFileChange;

test("切换辅助冻结版本并贯通 identity，子工作区只包含阻塞文件，不混入其它暂存", async () => {
  const requests: unknown[] = [];
  const expectedState = {
    headCommitHash: "a".repeat(40),
    branchName: "main",
    indexFingerprint: "b".repeat(64),
    worktreeFingerprint: "c".repeat(64),
  };
  const service = {
    getPublishState: async (params: unknown) => {
      requests.push(params);
      return expectedState;
    },
    getChanges: async (params: { sourceId: string }) => {
      requests.push(params);
      return params.sourceId === "staged" ? [file("other.ts")] : [file("sub/a.ts")];
    },
    getIdentity: async (params: unknown) => {
      requests.push(params);
      return { userName: "Fixture", userEmail: "fixture@example.invalid" };
    },
  } as unknown as IGitService;
  const state = await buildGitBranchSwitchAssistState({
    gitService: service,
    workspacePath: "/repo/sub",
    workspaceIdentity: "remote:sub",
    result,
  });
  assert.deepEqual(state?.stagePaths, ["/repo/sub/a.ts"]);
  assert.equal(state?.fileCount, 1);
  assert.equal(state?.expectedState, expectedState);
  for (const request of requests)
    assert.equal((request as { workspaceIdentity: string }).workspaceIdentity, "remote:sub");
});

test("文件读取失败不能构造部分成功的切换提交预览", async () => {
  const service = {
    getPublishState: async () => ({}),
    getChanges: async () => {
      throw new Error("fixture read failure");
    },
    getIdentity: async () => ({}),
  } as unknown as IGitService;
  assert.equal(
    await buildGitBranchSwitchAssistState({ gitService: service, workspacePath: "/repo", result }),
    null,
  );
});
