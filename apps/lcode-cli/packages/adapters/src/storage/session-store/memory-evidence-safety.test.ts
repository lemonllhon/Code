import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MessageId, PartId, ProjectId, SessionId } from "@lcode/contracts";
import { createSqliteSessionStore } from "../session-store.js";

for (const scenario of [
  "compact-original",
  "synthetic",
  "hidden",
  "review",
  "direct-write",
  "rewind",
  "execution-facts",
] as const) {
  test(`memory projection preserves source controls: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-controls-"));
    const store = createSqliteSessionStore({ dbPath: join(root, "test.db") });
    const sessionID = "sess_control" as SessionId;
    const id = (i: number) => `message_${i}` as MessageId;
    try {
      await store.createSession({
        id: sessionID,
        projectID: "fixture" as ProjectId,
        directory: root,
        slug: "fixture",
        title: "fixture",
        version: "1",
      });
      for (let i = 0; i < 4; i++) {
        const base = {
          id: id(i),
          sessionID,
          time: { created: i + 1, completed: i + 2 },
          agent: "build",
        };
        await store.saveMessage(
          i === 0
            ? {
                ...base,
                role: "user",
                synthetic: scenario === "synthetic",
                visibility: scenario === "hidden" ? "model-only" : "user-visible",
              }
            : {
                ...base,
                role: "assistant",
                parentID: id(0),
                mode: "build",
                path: { root, cwd: root },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                summary: i === 2,
              },
        );
        await store.savePart({
          id: `part_${i}` as PartId,
          sessionID,
          messageID: id(i),
          type: "text",
          text: ["记", "DERIVED_MARKER", "DERIVED_SUMMARY", "FINAL_FACT"][i]!,
        });
      }
      await store.savePart({
        id: "compact" as PartId,
        sessionID,
        messageID: id(1),
        type: "compaction",
        auto: true,
      });
      if (scenario === "review" || scenario === "direct-write")
        await store.savePart({
          id: "control" as PartId,
          sessionID,
          messageID: id(3),
          type: "tool",
          tool: scenario === "review" ? "MemoryReview" : "Write",
          callID: "control",
          state: {
            status: "completed",
            input:
              scenario === "review"
                ? { action: "create" }
                : { file_path: join(root, "memory", "fact.md") },
            output: "",
            metadata: {},
            title: "fixture",
            time: { start: 1, end: 2 },
          },
        });
      if (scenario === "rewind")
        await store.setRevert({
          sessionID,
          revert: {
            messageID: id(1),
            targetMessageID: id(1),
            branchCutAfterMessageID: id(1),
            branchGeneration: 1,
          },
        });
      if (scenario === "execution-facts") {
        await store.savePart({
          id: "execution" as PartId,
          sessionID,
          messageID: id(3),
          type: "tool",
          tool: "Bash",
          callID: "known",
          state: {
            status: "completed",
            input: { command: "PRIVATE_CMD" },
            output: "PRIVATE_OUTPUT",
            metadata: { schemaVersion: 1, execution: { exitCode: 0, cancelled: false } },
            title: "fixture",
            time: { start: 1, end: 2 },
          },
        });
        for (let i = 0; i < 12; i++)
          await store.savePart({
            id: `unknown_${i}` as PartId,
            sessionID,
            messageID: id(3),
            type: "tool",
            tool: "Read",
            callID: `unknown_${i}`,
            state: {
              status: "completed",
              input: {},
              output: "UNKNOWN_RESULT",
              metadata: {},
              title: "fixture",
              time: { start: 1, end: 2 },
            },
          });
      }
      const page = await store.readMemoryReviewEvidence({
        sessionID,
        startMessageID: id(0),
        throughMessageID: id(3),
        maxCharacters: 1024,
        memoryScope: { rootDir: join(root, "memory"), workingDirectory: root },
      });
      if (scenario === "compact-original" || scenario === "execution-facts") {
        assert.equal(page.status, "ready");
        assert.match(page.content, /User: 记/u);
        assert.match(page.content, /FINAL_FACT/u);
        assert.doesNotMatch(page.content, /DERIVED_|PRIVATE_|UNKNOWN_RESULT/u);
        const invalid = await store.readMemoryReviewEvidence({
          sessionID,
          startMessageID: id(0),
          throughMessageID: id(3),
          maxCharacters: 1024,
          cursor: { messageId: id(0), partId: "part_0", offset: 9999, selection: page.selection },
        });
        assert.equal(invalid.reason, "stale-source");
        if (scenario === "execution-facts") assert.match(page.content, /"exitCode":0/u);
      } else {
        assert.equal(page.status, "unavailable");
        assert.equal(page.content, "");
        assert.equal(
          page.reason,
          scenario === "review"
            ? "foreground-review"
            : scenario === "direct-write"
              ? "direct-memory-write"
              : scenario === "rewind"
                ? "branch-unprovable"
                : "no-user-prose",
        );
      }
    } finally {
      store.close();
      await rm(root, { force: true, recursive: true });
    }
  });
}
