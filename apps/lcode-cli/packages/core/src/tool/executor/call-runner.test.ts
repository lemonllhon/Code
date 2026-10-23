import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent, type SkillTelemetryMetadata } from "@lcode/contracts";
import { PermissionService } from "../../permission/service.js";
import { ToolRegistryImpl } from "../registry.js";
import type { PersistedReadFileStateMetadata } from "../read-file-state-metadata.js";
import type { ToolEntry } from "../types.js";
import { createToolExecutor } from "./impl.js";
import type { ToolExecutorOptions } from "./types.js";

const readMetadata: PersistedReadFileStateMetadata = {
  schemaVersion: 1,
  tool: "Read",
  path: "test-file",
  content: "test-content",
  isPartialView: false,
  readAtMs: 1000,
  revisionId: "revision",
  mtimeMs: 1000,
  sizeBytes: 12,
};
const skillMetadata: SkillTelemetryMetadata = { qualifiedName: "test-skill" };
const readOnlyToolMetadata = {
  readOnly: true,
  riskLevel: "low" as const,
  sideEffectScope: "none" as const,
  destructive: false,
  concurrentSafe: true,
  needsApproval: false,
};

function executor(entry: Partial<ToolEntry>, options: Partial<ToolExecutorOptions> = {}) {
  const registry = new ToolRegistryImpl();
  registry.register({
    metadata: { name: "TestTool", readOnly: true, riskLevel: "low", sideEffectScope: "none" },
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    ...entry,
  } as ToolEntry);
  const events: SessionEvent[] = [];
  return {
    events,
    executor: createToolExecutor({
      registry,
      permissionService: new PermissionService(),
      emitEvent: async (event) => {
        events.push(event);
      },
      sessionId: "test-session",
      getWorkingDirectory: () => process.cwd(),
      getWorkspaceRoot: () => process.cwd(),
      getMode: () => "yolo",
      ...options,
    } as ToolExecutorOptions),
  };
}

test("MCP-owned projectMemberId reaches its own handler unchanged and never enters native routing", async () => {
  for (const routed of [false, true]) {
    let routeCalls = 0;
    const inputs: unknown[] = [];
    const setup = executor(
      {
        metadata: { ...readOnlyToolMetadata, name: "mcp__fixture__read" },
        aliases: ["McpReadAlias"],
        inputSchema: {
          type: "object",
          required: ["projectMemberId"],
          properties: { projectMemberId: {} },
        },
        handler: async (input) => {
          inputs.push(input);
          return { done: true };
        },
      },
      routed
        ? {
            resolveProjectToolScope: () => {
              routeCalls++;
              throw new Error("must not route MCP");
            },
          }
        : {},
    );
    for (const projectMemberId of ["server-owned-project", 42, null]) {
      const input = { projectMemberId };
      const result = await setup.executor.execute({
        id: `mcp-${inputs.length}`,
        name: "McpReadAlias",
        input,
      });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.deepEqual(inputs.at(-1), input);
    }
    assert.equal(routeCalls, 0);
  }
});

test("MCP-owned selector still uses its own schema rather than the native selector schema", async () => {
  let calls = 0;
  const setup = executor({
    metadata: { ...readOnlyToolMetadata, name: "mcp__fixture__read" },
    inputSchema: {
      type: "object",
      required: ["projectMemberId"],
      properties: { projectMemberId: { type: "number" } },
    },
    handler: async () => {
      calls++;
      return { done: true };
    },
  });
  const result = await setup.executor.execute({
    id: "invalid-mcp",
    name: "mcp__fixture__read",
    input: { projectMemberId: "invalid-number" },
  });
  assert.equal(result.success, false);
  assert.doesNotMatch(result.error?.message ?? "", /Target folder routing/);
  assert.equal(calls, 0);
});

test("native routing rejection still blocks execution and logs no input or selector", async () => {
  let calls = 0;
  const logs: unknown[] = [];
  const logger: NonNullable<ToolExecutorOptions["logger"]> = {
    debug() {},
    info() {},
    error() {},
    child: () => logger,
    warn: (message, context) => {
      logs.push({ message, context });
    },
  };
  const setup = executor(
    {
      metadata: { ...readOnlyToolMetadata, name: "Read" },
      handler: async () => {
        calls++;
        return { done: true };
      },
    },
    { logger },
  );
  const result = await setup.executor.execute({
    id: "native-rejected",
    name: "Read",
    input: { projectMemberId: "synthetic-private-selector", file_path: "synthetic-private-path" },
  });
  assert.equal(result.success, false);
  assert.match(result.error?.message ?? "", /Target folder routing/);
  assert.equal(calls, 0);
  const serialized = JSON.stringify(logs);
  assert.match(serialized, /tool.project_routing.rejected/);
  assert.match(serialized, /native-rejected/);
  assert.equal(serialized.includes("synthetic-private-selector"), false);
  assert.equal(serialized.includes("synthetic-private-path"), false);
});

test("execution context metadata callbacks update the enclosing result owner", async () => {
  const setup = executor({
    handler: async (_input, context) => {
      context.recordReadFileStateMetadata?.(readMetadata);
      context.recordSkillTelemetryMetadata?.(skillMetadata);
      return { done: true };
    },
  });
  const result = await setup.executor.execute({
    id: "test-call",
    name: "TestTool",
    input: {},
  } as never);
  assert.equal(result.success, true);
  assert.equal(result.readFileStateMetadata, readMetadata);
  const terminal = setup.events.find((event) => event.type === SessionEventType.ToolCallResult);
  assert.ok(terminal);
  assert.equal(
    (terminal.payload as { skillMetadata?: SkillTelemetryMetadata }).skillMetadata,
    skillMetadata,
  );
});

test("handler failures preserve skill metadata without retrying", async () => {
  let calls = 0;
  const setup = executor({
    handler: async (_input, context) => {
      calls++;
      context.recordSkillTelemetryMetadata?.(skillMetadata);
      throw new Error("mock handler failure");
    },
  });
  const result = await setup.executor.execute({
    id: "failed-call",
    name: "TestTool",
    input: {},
  } as never);
  assert.equal(result.success, false);
  assert.equal(calls, 1);
  const terminal = setup.events.find((event) => event.type === SessionEventType.ToolCallError);
  assert.ok(terminal);
  assert.equal(
    (terminal.payload as { skillMetadata?: SkillTelemetryMetadata }).skillMetadata,
    skillMetadata,
  );
});

test("invalid tool input emits failure before the handler starts", async () => {
  let calls = 0;
  const setup = executor({
    inputSchema: {
      type: "object",
      required: ["file_path"],
      properties: { file_path: { type: "string" } },
    },
    handler: async () => {
      calls++;
      return {};
    },
  });
  const result = await setup.executor.execute({
    id: "invalid-call",
    name: "TestTool",
    input: {},
  } as never);
  assert.equal(result.success, false);
  assert.equal(calls, 0);
  assert.match(result.error!.message, /required parameter `file_path` is missing/);
  assert.match(result.modelContent as string, /required parameter `file_path` is missing/);
  assert.deepEqual(
    setup.events.map((event) => event.type),
    [SessionEventType.ToolCallError],
  );
});

for (const code of ["invalid_json", "null_input"] as const) {
  test(`${code} rejects a permissive tool before hooks and lets a corrected call execute once`, async () => {
    let calls = 0;
    let hooks = 0;
    let parses = 0;
    const setup = executor(
      {
        // 无必填字段可以复现旧空对象兜底误执行的路径。
        inputSchema: { type: "object" },
        runtimeInputSchema: {
          safeParse: () => {
            parses++;
            return { success: true, data: {} };
          },
        },
        handler: async () => {
          calls++;
          return {};
        },
      },
      {
        hookRunner: {
          run: async () => {
            hooks++;
            return { additionalContexts: [] };
          },
        } as never,
      },
    );
    const failure = await setup.executor.execute({
      id: "malformed-call",
      name: "TestTool",
      input: {},
      inputError: { code, inputLength: 5974 },
    } as never);
    assert.equal(failure.success, false);
    assert.equal(failure.error?.code, "TOOL_EXECUTION_FAILED");
    assert.match(
      failure.error!.message,
      code === "invalid_json" ? /invalid or incomplete JSON/ : /received null/,
    );
    assert.match(failure.modelContent as string, /Retry.*complete JSON object/);
    assert.doesNotMatch(failure.error!.message, /required parameter|max_tokens|output limit/);
    assert.equal(calls, 0);
    assert.equal(hooks, 0);
    assert.equal(parses, 0);
    assert.deepEqual(
      setup.events.map((event) => event.type),
      [SessionEventType.ToolCallError],
    );
    const corrected = await setup.executor.execute({
      id: "corrected-call",
      name: "TestTool",
      input: {},
    } as never);
    assert.equal(corrected.success, true);
    assert.equal(calls, 1);
    assert.equal(parses, 1);
    assert.ok(hooks > 0);
  });
}

test("malformed parse-error metadata is rejected without leaking its contents", async () => {
  let calls = 0;
  const setup = executor({
    handler: async () => {
      calls++;
      return {};
    },
  });
  const result = await setup.executor.execute({
    id: "invalid-metadata",
    name: "TestTool",
    input: {},
    inputError: { code: "invalid_json", inputLength: -1, rawInput: "private fixture content" },
  } as never);
  assert.equal(result.success, false);
  assert.equal(calls, 0);
  assert.doesNotMatch(JSON.stringify(result), /private fixture content/);
});
