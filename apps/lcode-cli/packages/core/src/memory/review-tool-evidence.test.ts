import assert from "node:assert/strict";
import test from "node:test";
import type { MessageWithParts, ToolPart } from "@lcode/contracts";
import { projectReviewToolEvidence } from "./review-tool-evidence.js";
import { completedToolPartMetadata } from "../runtime/methods/tool-part-metadata.js";

test("structured tool evidence never infers success from prose, completed or background launch", () => {
  const part = (callID: string, metadata: Record<string, unknown>): ToolPart =>
    ({
      id: callID,
      sessionID: "session",
      messageID: "message",
      type: "tool",
      callID,
      tool: "Bash",
      state: {
        status: "completed",
        input: { command: "SECRET_COMMAND" },
        output: "ALL TESTS PASSED SECRET_OUTPUT",
        title: "Bash",
        metadata,
        time: { start: 1, end: 2 },
      },
    }) as ToolPart;
  const messages = [
    {
      parts: [
        part("known", { schemaVersion: 1, execution: { exitCode: 1, cancelled: false } }),
        part("unknown", {}),
        part("background", { schemaVersion: 1, execution: { exitCode: null, cancelled: false } }),
        ...Array.from({ length: 12 }, (_, index) => part(`unknown-${index}`, {})),
      ],
    },
  ] as MessageWithParts[];
  const result = projectReviewToolEvidence(messages);
  assert.ok(result.text.includes('"exitCode":1'));
  assert.ok(result.text.includes('"exitCode":null'));
  assert.ok(!result.text.includes('"exitCode":0'));
  assert.ok(!result.text.includes("SECRET"));
});

test("persisted Bash evidence distinguishes exit status from tool handler success", () => {
  const metadata = (output: unknown) =>
    completedToolPartMetadata({ toolName: "Bash", output } as never).execution;
  assert.deepEqual(metadata({ stdout: "", stderr: "", interrupted: false, exitCode: 2 }), {
    exitCode: 2,
    cancelled: false,
  });
  assert.deepEqual(
    metadata({ stdout: "", stderr: "", interrupted: false, exitCode: 0, status: "backgrounded" }),
    { exitCode: null, cancelled: false },
  );
  assert.deepEqual(metadata({ stdout: "", stderr: "", interrupted: true, exitCode: 0 }), {
    exitCode: null,
    cancelled: true,
  });
  assert.equal(metadata({ text: "exitCode=0" }), undefined);
  assert.deepEqual(
    metadata({ stdout: "", stderr: "", interrupted: false, exitCode: 0, status: "cancelled" }),
    { exitCode: null, cancelled: true },
  );
  assert.deepEqual(
    metadata({ stdout: "", stderr: "", interrupted: false, exitCode: 0, status: "timed_out" }),
    { exitCode: null, cancelled: false },
  );
});
