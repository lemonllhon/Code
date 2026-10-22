import assert from "node:assert/strict";
import test from "node:test";
import { projectRemovalBlockedReason } from "./projectRemovalPolicy.js";

const disconnected = {
  hasExecutionSets: false,
  hasIndependentChats: false,
  hasWorktrees: false,
  isRemote: true,
  sourceConnected: false,
  sourceLoading: false,
  sourceUnavailable: true,
};

test("offline deletion can initiate reconnect, then validates dependencies against the original source", () => {
  assert.equal(projectRemovalBlockedReason(disconnected), undefined);
  assert.equal(projectRemovalBlockedReason({ ...disconnected, sourceLoading: true }), undefined);
});

test("known dependencies keep disconnected origins protected", () => {
  for (const [flag, reason] of [
    ["hasExecutionSets", "activeExecutionSet"],
    ["hasWorktrees", "activeBinding"],
  ] as const)
    assert.equal(projectRemovalBlockedReason({ ...disconnected, [flag]: true }), reason);
});

test("separately placed chats are included in project deletion rather than blocking it", () => {
  assert.equal(
    projectRemovalBlockedReason({
      ...disconnected,
      sourceConnected: true,
      sourceUnavailable: false,
      hasIndependentChats: true,
    }),
    undefined,
  );
});

test("local and connected remote sources still require their own verification", () => {
  for (const isRemote of [false, true]) {
    const facts = { ...disconnected, isRemote, sourceConnected: true };
    assert.equal(projectRemovalBlockedReason(facts), "verifySource");
    assert.equal(
      projectRemovalBlockedReason({ ...facts, sourceUnavailable: false, sourceLoading: true }),
      "verifySource",
    );
    assert.equal(projectRemovalBlockedReason({ ...facts, sourceUnavailable: false }), undefined);
  }
});
