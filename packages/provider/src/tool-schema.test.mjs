import assert from "node:assert/strict";
import test from "node:test";
import { objectToolSchema, prepareToolSchemas } from "./tool-schema.ts";

const git = {
  oneOf: [
    {
      type: "object",
      properties: { action: { const: "inspect" }, url: { type: "string" } },
      required: ["action", "url"],
    },
    {
      type: "object",
      properties: { action: { const: "bind" }, username: { type: "string" } },
      required: ["action", "username"],
    },
    {
      type: "object",
      properties: {
        action: { enum: ["fetch", "push", "ls-remote"] },
        refs: { type: "array", items: { type: "string" } },
      },
      required: ["action"],
    },
  ],
};

test("object tool projection preserves all discriminants, fields, original schema and is idempotent", () => {
  const original = structuredClone(git);
  const output = objectToolSchema(git);
  assert.equal(output.type, "object");
  assert.deepEqual(output.properties.action, {
    type: "string",
    enum: ["inspect", "bind", "fetch", "push", "ls-remote"],
  });
  assert.deepEqual(Object.keys(output.properties), ["action", "url", "username", "refs"]);
  assert.deepEqual(output.required, ["action"]);
  assert.deepEqual(objectToolSchema(output), output);
  assert.deepEqual(git, original);
});

test("all wire protocols preserve the five Git actions", () => {
  for (const protocol of ["openai-chat-completions", "openai-responses", "anthropic-messages"]) {
    const fn =
      protocol === "anthropic-messages"
        ? { name: "Git", input_schema: git }
        : { name: "Git", parameters: git };
    const body = prepareToolSchemas(
      {
        tools: [
          protocol === "openai-chat-completions"
            ? { type: "function", function: fn }
            : { type: "function", ...fn },
        ],
      },
      protocol,
      { objectRoots: true },
    );
    const tool = body.tools[0];
    const entry = protocol === "openai-chat-completions" ? tool.function : tool;
    assert.deepEqual(
      entry[protocol === "anthropic-messages" ? "input_schema" : "parameters"],
      objectToolSchema(git),
    );
  }
});

test("unresolvable, cyclic and scalar roots fail explicitly instead of losing a branch", () => {
  for (const schema of [
    { const: "scalar" },
    { oneOf: [{ type: "object" }, { enum: ["scalar"] }] },
    { $ref: "#/missing" },
    { $ref: "#" },
    { oneOf: [{ type: "object" }, { type: "string" }] },
  ]) {
    assert.throws(() => objectToolSchema(schema), /schema|Schema/);
  }
});
