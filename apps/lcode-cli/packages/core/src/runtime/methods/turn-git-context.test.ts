import test from "node:test";
import assert from "node:assert/strict";
import { appendGitContextForModelStep, formatGitAgentContext } from "./turn-git-context.js";
import {
  filterTurnRecallOverlayEntries,
  withTurnRecallOverlaysDetached,
} from "./turn-loop-state.js";
import {
  createRuntimeUserEntry,
  systemReminderAttachmentEntry,
} from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import type { GitAgentContext } from "@lcode/shared";

const context = (username: string): GitAgentContext => ({
  status: "available",
  partial: false,
  repositories: [
    {
      workspacePath: "/repo",
      revision: username,
      status: "available",
      partial: false,
      remotes: [
        {
          name: "origin",
          url: "https://example.invalid/repo.git",
          authentication: {
            status: "selected",
            account: { name: username, username, provider: "gitlab" },
          },
        },
      ],
    },
  ],
});
test("Git facts refresh every step alongside memory, never enter recorded/compact history, and failures remove old accounts", async () => {
  const user = createRuntimeUserEntry("提交改动"),
    memory = systemReminderAttachmentEntry("memory_recall", "提交遵守 Conventional Commits");
  const state = {
    turnAbortSignal: new AbortController().signal,
    turnRequestState: { entries: [user, memory], outputTokenContinuationCount: 0 },
  } as unknown as RegularTurnLoopState;
  let value: GitAgentContext = context("alice");
  const runtime = { resolveGitContext: async () => value } as unknown as AgentRuntimeInternal;
  await appendGitContextForModelStep(runtime, state);
  assert.match(JSON.stringify(state.turnRequestState.entries), /alice/);
  assert.deepEqual(filterTurnRecallOverlayEntries(state.turnRequestState.entries), [user]);
  await withTurnRecallOverlaysDetached(state.turnRequestState, async () => {
    assert.deepEqual(state.turnRequestState.entries, [user]);
  });
  value = context("bob");
  await appendGitContextForModelStep(runtime, state);
  assert.doesNotMatch(JSON.stringify(state.turnRequestState.entries), /alice/);
  assert.match(JSON.stringify(state.turnRequestState.entries), /bob/);
  runtime.resolveGitContext = async () => {
    throw new Error("private failure fixture");
  };
  await appendGitContextForModelStep(runtime, state);
  assert.doesNotMatch(
    JSON.stringify(state.turnRequestState.entries),
    /bob|private failure fixture/,
  );
  assert.match(JSON.stringify(state.turnRequestState.entries), /unavailable/);
  assert.equal(state.turnRequestState.entries[1], memory);
  runtime.resolveGitContext = undefined;
  await appendGitContextForModelStep(runtime, state);
  assert.deepEqual(state.turnRequestState.entries, [user, memory]);
});
test("Cancellation discards a late snapshot and context formatting is bounded without copying secrets or IDs", async () => {
  const controller = new AbortController();
  const state = {
    turnAbortSignal: controller.signal,
    turnRequestState: { entries: [], outputTokenContinuationCount: 0 },
  } as unknown as RegularTurnLoopState;
  const runtime = {
    resolveGitContext: async () => {
      controller.abort();
      return context("late");
    },
  } as unknown as AgentRuntimeInternal;
  await assert.rejects(appendGitContextForModelStep(runtime, state), { name: "AbortError" });
  assert.deepEqual(state.turnRequestState.entries, []);
  const huge = context("x".repeat(8000));
  const text = formatGitAgentContext(huge);
  assert.ok(text.length < 11000);
  assert.match(text, /"partial":true/);
});
