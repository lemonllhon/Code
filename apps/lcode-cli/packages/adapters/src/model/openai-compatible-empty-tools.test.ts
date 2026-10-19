import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const require = createRequire(import.meta.url);
const commonJS = require("@ai-sdk/openai-compatible") as typeof import("@ai-sdk/openai-compatible");
type Delta = Record<string, unknown>;

async function consume(
  create: typeof createOpenAICompatible,
  deltas: Delta[],
  finishReason = "stop",
  failure?: Error,
) {
  const frames = deltas.map((delta) => ({
    id: "fixture",
    model: "fixture",
    created: 0,
    choices: [{ index: 0, delta, finish_reason: null }],
  }));
  const body =
    [
      ...frames,
      { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } },
    ]
      .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
      .join("") + "data: [DONE]\n\n";
  const provider = create({
    name: "fixture",
    baseURL: "https://fixture.invalid/v1",
    fetch: async () =>
      new Response(
        failure
          ? new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
                  ),
                );
              },
              pull(controller) {
                controller.error(failure);
              },
            })
          : body,
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  const result = await provider.chatModel("fixture").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "fixture" }] }],
    maxOutputTokens: 16,
  });
  const events = [];
  for await (const event of result.stream) events.push(event);
  return events;
}

for (const [name, create] of [
  ["esm", createOpenAICompatible],
  ["cjs", commonJS.createOpenAICompatible],
] as const) {
  for (const field of [undefined, null, []]) {
    test(`${name}: empty tool arrays preserve a continuous reasoning block (${JSON.stringify(field)})`, async () => {
      const events = await consume(
        create,
        ["first ", "第二段\n", "🦊"].map((text) => ({
          reasoning_content: text,
          ...(field === undefined ? {} : { tool_calls: field }),
        })),
      );
      assert.equal(events.filter((e) => e.type === "reasoning-start").length, 1);
      assert.equal(events.filter((e) => e.type === "reasoning-end").length, 1);
      assert.equal(
        events
          .filter((e) => e.type === "reasoning-delta")
          .map((e) => e.delta)
          .join(""),
        "first 第二段\n🦊",
      );
      const finish = events.find((e) => e.type === "finish");
      assert.equal(finish?.usage.inputTokens.total, 12);
      assert.equal(finish?.usage.outputTokens.total, 3);
    });
  }

  test(`${name}: real tools and text remain reasoning boundaries`, async () => {
    const events = await consume(
      create,
      [
        { reasoning_content: "before", tool_calls: [] },
        { content: "visible", tool_calls: [] },
        { reasoning_content: "after", tool_calls: [] },
        {
          tool_calls: [
            {
              index: 0,
              id: "call-1",
              type: "function",
              function: { name: "Read", arguments: '{"file_path":"fixture"}' },
            },
          ],
        },
      ],
      "tool_calls",
    );
    assert.equal(events.filter((e) => e.type === "reasoning-start").length, 2);
    assert.equal(events.filter((e) => e.type === "reasoning-end").length, 2);
    assert.equal(events.filter((e) => e.type === "tool-call").length, 1);
    assert.equal(
      events
        .filter((e) => e.type === "text-delta")
        .map((e) => e.delta)
        .join(""),
      "visible",
    );
  });

  test(`${name}: malformed tools remain a schema error`, async () => {
    const events = await consume(create, [{ reasoning_content: "partial", tool_calls: "invalid" }]);
    assert.ok(events.some((e) => e.type === "error"));
  });

  test(`${name}: transport failure and abort are never converted to partial success`, async () => {
    for (const error of [Error("stream disconnected"), new DOMException("aborted", "AbortError")]) {
      await assert.rejects(
        consume(create, [{ reasoning_content: "partial", tool_calls: [] }], "stop", error),
        (actual) => actual === error,
      );
    }
  });
}

test("ten thousand empty-array deltas do not inflate blocks", async () => {
  const events = await consume(
    createOpenAICompatible,
    Array.from({ length: 10_000 }, () => ({
      reasoning_content: "x",
      tool_calls: [],
    })),
  );
  assert.equal(events.filter((e) => e.type === "reasoning-start").length, 1);
  assert.equal(events.filter((e) => e.type === "reasoning-end").length, 1);
  assert.equal(events.filter((e) => e.type === "reasoning-delta").length, 10_000);
});
