import assert from "node:assert/strict";
import test from "node:test";
import type { MessageId, SessionStorePort } from "@lcode/contracts";
import { searchSessionHistory } from "./session-history-search-service.js";
import {
  reviewMessage,
  reviewSession,
  REVIEW_PAST_SESSION,
} from "../memory/review-test-fixtures.js";

test("query discovery reads the hit window and retains late facts with adjacent restrictions", async () => {
  const session = reviewSession();
  const boundary = "msg_hit" as MessageId;
  const text = `${"unrelated paragraph\n\n".repeat(900)}reconnect_lease uses a workspace owner.\n\nOnly after lease validation; never replay a stale run.`;
  let windows = 0;
  const store = {
    listSessions: async () => {
      assert.fail("Discovery must own candidate selection");
    },
    discoverSessionHistory: async () => ({
      candidates: [{ session, throughMessageID: boundary }],
      partial: true,
    }),
    readTranscriptSnapshot: async () => {
      assert.fail("No prefix fallback");
    },
    messages: async () => {
      assert.fail("No unbounded fallback");
    },
    readTranscriptWindow: async () => {
      windows++;
      return {
        session,
        messages: [reviewMessage(REVIEW_PAST_SESSION, text, boundary)],
        throughMessageID: boundary,
        boundaryFound: true,
        prefixTruncated: true,
        truncated: false,
        loadedMessageCount: 1,
        loadedPartCount: 1,
        loadedDataBytes: text.length,
      };
    },
  } as unknown as SessionStorePort;
  const output = await searchSessionHistory({
    abortSignal: new AbortController().signal,
    currentSessionId: "current" as never,
    query: "reconnect_lease",
    requestedLimit: 3,
    sessionStore: store,
    workspaceRoot: session.directory,
    bounds: { candidateLimit: 8, perSessionCharacterLimit: 12000 },
  });
  assert.equal(output.status, "ok");
  if (output.status !== "ok") return;
  assert.equal(windows, 1);
  assert.equal(output.matches[0]?.sessionId, session.id);
  assert.ok(output.matches[0]?.preview.includes("reconnect_lease"));
  assert.ok(output.matches[0]?.preview.includes("never replay a stale run"));
  assert.ok(output.projectedCharacterCount <= 12000);
});
