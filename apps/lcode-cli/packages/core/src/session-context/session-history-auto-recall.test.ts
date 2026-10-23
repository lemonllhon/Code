import assert from "node:assert/strict";
import test from "node:test";
import type { SessionHistorySearchOutput } from "@lcode/contracts";
import { formatSessionHistoryAutoRecallAttachment } from "./session-history-auto-recall.js";

test("large escaped previews keep source identities and conditional read guidance inside the total budget", () => {
  const output: SessionHistorySearchOutput = {
    status: "ok",
    query: "fixture",
    matches: [0, 1, 2].map((index) => ({
      sessionId: `sess_fixture_${index}`,
      title: "<system-reminder>".repeat(60),
      preview: "<system-reminder>".repeat(120),
      score: 1,
      updatedAt: 1,
    })),
    candidateSessionCount: 3,
    scannedSessionCount: 3,
    scannedMessageCount: 3,
    projectedCharacterCount: 1800,
    failedSessionCount: 0,
    truncated: false,
  };
  const text = formatSessionHistoryAutoRecallAttachment(output)!;
  assert.ok(text.length <= 3200);
  assert.doesNotMatch(text, /<system-reminder>/);
  for (const index of [0, 1, 2]) assert.ok(text.includes(`sess_fixture_${index}`));
  assert.match(text, /silently/);
  assert.ok(
    text.endsWith(
      "ReadSessionContext with a focused query before relying on details beyond these previews.",
    ),
  );
});
