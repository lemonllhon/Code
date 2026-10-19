import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveBuildAliases } from "../apps/lcode-cli/packages/cli/scripts/build.mjs";

const requireFromCli = createRequire(
  new URL("../apps/lcode-cli/packages/cli/scripts/build.mjs", import.meta.url),
);
const { build } = requireFromCli("esbuild");

test("desktop agent bundle resolution includes the installed empty tool array patch", async () => {
  const bundle = await build({
    stdin: {
      contents: 'export { createOpenAICompatible } from "@ai-sdk/openai-compatible";',
      resolveDir: fileURLToPath(
        new URL("../apps/lcode-cli/packages/adapters/src/model/", import.meta.url),
      ),
    },
    alias: resolveBuildAliases(),
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  assert.ok(Object.keys(bundle.metafile.inputs).some((path) => path.includes("openai-compatible")));
  const { createOpenAICompatible } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
  const frames = ["first", "second", "third"].map((text) => ({
    choices: [
      { index: 0, delta: { reasoning_content: text, tool_calls: [] }, finish_reason: null },
    ],
  }));
  frames.push({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  const body =
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
  const provider = createOpenAICompatible({
    name: "fixture",
    baseURL: "https://fixture.invalid/v1",
    fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
  });
  const result = await provider.chatModel("fixture").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "fixture" }] }],
  });
  const events = [];
  for await (const event of result.stream) events.push(event);
  assert.equal(events.filter((event) => event.type === "reasoning-start").length, 1);
  assert.equal(events.filter((event) => event.type === "reasoning-end").length, 1);
  assert.equal(
    events
      .filter((event) => event.type === "reasoning-delta")
      .map((event) => event.delta)
      .join(""),
    "firstsecondthird",
  );
});
