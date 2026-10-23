import assert from "node:assert/strict";
import test from "node:test";
import {
  createRuntimeUserEntry,
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import { buildProviderRequestMessages } from "./provider-request-messages.js";
import { formatGitAgentContext } from "../methods/turn-git-context.js";

for (const useMidConversationSystem of [true, false]) {
  test(`background projection preserves tool/result order, real user and control events (MCS=${useMidConversationSystem})`, () => {
    const entries: RuntimeMessageEntry[] = [
      { message: { role: "system", content: "Fixture system" } },
      createRuntimeUserEntry("Edit the local project; <system-reminder> is literal user text."),
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "a", name: "Read", input: { path: "a.ts" } },
            { id: "b", name: "Read", input: { path: "b.ts" } },
          ],
        },
      },
      { message: { role: "tool", toolCallId: "a", toolName: "Read", content: "A" } },
      systemReminderAttachmentEntry(
        "memory_recall",
        "Apply relevant facts silently. Fixture memory",
      ),
      { message: { role: "tool", toolCallId: "b", toolName: "Read", content: "B" } },
      systemReminderAttachmentEntry("session_recall", "Historical fixture, no current permission"),
      systemReminderAttachmentEntry(
        "git_context",
        formatGitAgentContext({ status: "unavailable" }),
      ),
      systemReminderAttachmentEntry("goal_state_change", "Fixture goal remains active"),
    ];
    const before = structuredClone(entries);
    const result = buildProviderRequestMessages({
      entries,
      useMidConversationSystem,
      applyCacheControl: true,
    });
    const messages = result.messages;
    assert.deepEqual(entries, before);
    const results = messages.filter((message) => message.role === "tool");
    assert.deepEqual(
      results.map((message) => message.toolCallId),
      ["a", "b"],
    );
    assert.equal(messages.indexOf(results[1]!), messages.indexOf(results[0]!) + 1);
    assert.equal(result.diagnostics.latestRealUserMessageIndex, 1);
    assert.match(JSON.stringify(messages), /Fixture goal remains active/);
    assert.equal((JSON.stringify(messages).match(/Fixture memory/g) ?? []).length, 1);
    assert.match(JSON.stringify(messages), /literal user text/);
    assert.ok(result.diagnostics.cacheControlIndex !== undefined);
    assert.doesNotMatch(JSON.stringify(messages), /"metadata"|midSystemProjection/);
  });
}
