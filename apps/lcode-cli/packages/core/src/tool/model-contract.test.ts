import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistryImpl } from "./registry.js";
import { projectToolModelContract } from "./model-contract.js";
import type { ToolEntry } from "./types.js";

for (const name of ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Git"]) {
  test(`${name}: registry is capability-neutral and model projection adds only an available selector`, () => {
    const registry = new ToolRegistryImpl();
    const schema = {
      type: "object",
      required: ["value"],
      properties: { value: { type: "string" } },
    };
    registry.register({ metadata: { name }, inputSchema: schema } as unknown as ToolEntry);
    const entry = registry.get(name)!;
    const base = registry.toContracts()[0]!;
    assert.deepEqual(base.inputSchema, schema);
    assert.deepEqual(projectToolModelContract(base, entry, {}).inputSchema, schema);
    const routed = projectToolModelContract(base, entry, { projectRoutingAvailable: true });
    assert.ok("projectMemberId" in (routed.inputSchema as typeof schema).properties);
    assert.deepEqual((routed.inputSchema as typeof schema).required, ["value"]);
    assert.deepEqual(
      projectToolModelContract(base, entry, { projectRoutingAvailable: false }).inputSchema,
      schema,
    );
    assert.deepEqual(
      base.inputSchema,
      schema,
      "request projection cannot mutate the cached base schema",
    );
  });
}

test("model-specific union schemas retain their branches and MCP-owned selectors remain unchanged", () => {
  const registry = new ToolRegistryImpl();
  const schema = {
    anyOf: [
      { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
      { type: "object", properties: { pages: { type: "string" } }, required: ["pages"] },
    ],
  };
  registry.register({
    metadata: { name: "Read" },
    inputSchema: {},
    resolveModelContract: () => ({ inputSchema: schema, description: "model-specific" }),
  } as unknown as ToolEntry);
  const base = registry.toContracts()[0]!;
  const entry = registry.get("Read")!;
  assert.deepEqual(projectToolModelContract(base, entry, {}).inputSchema, schema);
  const routed = projectToolModelContract(base, entry, { projectRoutingAvailable: true });
  for (const branch of (routed.inputSchema as typeof schema).anyOf)
    assert.ok("projectMemberId" in branch.properties);
  assert.equal(routed.description, "model-specific");
  const mcp = {
    ...base,
    name: "mcp__idea__read",
    inputSchema: { type: "object", properties: { projectMemberId: { type: "number" } } },
  };
  assert.deepEqual(
    projectToolModelContract(mcp, undefined, { projectRoutingAvailable: true }),
    mcp,
  );
});
