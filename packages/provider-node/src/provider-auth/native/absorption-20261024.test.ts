import assert from "node:assert/strict";
import test from "node:test";
import { GoogleModels } from "./google-models.js";
import { prepareResponses } from "./openai-request.js";

test("Antigravity omits disabled entries without inventing a fallback for a disabled directory", async () => {
  for (const models of [
    { "gemini-3-flash": { disabled: true } },
    { "gemini-3-flash": { disabled: true }, "claude-sonnet-4-6": { disabled: false } },
  ]) {
    const catalog = new GoogleModels(
      "antigravity",
      async () => ({ models }),
      async () => Response.json({}),
    );
    const result = await catalog.models(
      { type: "oauth", access: "fixture", projectId: "fixture" },
      new AbortController().signal,
    );
    assert.equal(
      result.some((model) => model.id === "gemini-3-flash"),
      false,
    );
    assert.equal(result.length, Object.keys(models).length - 1);
    assert.equal(catalog.fellBack, false);
  }
});

test("Codex replays items without response status/id and leaves the transcript untouched", () => {
  const input = [
    {
      type: "message",
      role: "assistant",
      id: "old-message",
      status: "completed",
      content: [{ type: "output_text", text: "fixture" }],
    },
    {
      type: "function_call",
      id: "old-call",
      status: "completed",
      call_id: "pair",
      name: "Read",
      arguments: "{}",
    },
    {
      type: "function_call_output",
      id: "old-output",
      status: "completed",
      call_id: "pair",
      output: "result",
    },
    { type: "reasoning", id: "old-reasoning", status: "incomplete", encrypted_content: "fixture" },
  ];
  const before = structuredClone(input);
  const out = prepareResponses({ model: "fixture", input }, "codex");
  assert.deepEqual(input, before);
  assert.ok(
    (out.input as Record<string, unknown>[]).every(
      (item) => !("status" in item) && !("id" in item),
    ),
  );
  assert.equal((out.input as Record<string, unknown>[])[1]!.call_id, "pair");
  assert.equal((out.input as Record<string, unknown>[])[2]!.output, "result");
});
