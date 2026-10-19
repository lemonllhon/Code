import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNodeFileSystemAdapter, createSqliteSessionStore } from "@lcode/adapters";
import { AgentRuntime } from "@lcode/core";
import {
  createInMemorySessionEventStore,
  type MessageId,
  type Model,
  type ModelRequest,
  type PartId,
  type ProjectId,
  type SessionId,
  type TurnId,
} from "@lcode/contracts";

test("cold explicit retry resumes durable page checkpoints with a small model and never silently backfills history", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "memory-resume-"));
  const store = createSqliteSessionStore({ dbPath: join(root, "test.db") });
  const sessionID = "sess_resume_fixture" as SessionId;
  const start = "user" as MessageId,
    end = "assistant" as MessageId,
    turnId = "turn_fixture" as TurnId;
  const requests: string[] = [],
    successful: string[] = [];
  let fail = true;
  const model = {
    providerId: "fixture",
    modelId: "small",
    displayName: "Fixture",
    options: {},
    optionSpecs: { maxOutputTokens: { max: 4096 }, reasoningLevel: { values: ["low"] } },
    properties: {
      contextWindow: 8192,
      inputFormat: { supportsText: true },
      supportsMidConversationSystem: true,
    },
    bind: () => model,
    generateText: async (request: ModelRequest) => {
      assert.deepEqual(request.tools, []);
      const payload = JSON.parse(String(request.messages[1]!.content));
      const text = payload.sources
        .filter((source: { kind: string }) => source.kind === "session")
        .map((source: { content: string }) => source.content)
        .join("\n");
      requests.push(text);
      if (requests.length === 3 && fail) throw new Error("fixture interrupted segment");
      successful.push(text);
      return {
        text: JSON.stringify({ summary: "Nothing new", items: [] }),
        finishReason: "stop",
        usage: {},
      };
    },
  } as unknown as Model;
  const config = {
    workingDirectory: root,
    workspacePath: root,
    mode: "yolo" as const,
    modelSelection: { providerId: "fixture", modelId: "small" },
    memory: {
      enabled: true,
      use: true,
      storageLocation: "workspace" as const,
      cliStorageRoot: join(root, "profile", "cli"),
    },
    modelStreaming: "off" as const,
    titleGeneration: { enabled: false },
    compact: { enabled: false },
    subagents: { enabled: false },
    mcp: { enabled: false },
  };
  const createRuntime = () =>
    new AgentRuntime(sessionID, config, {
      sessionStore: store,
      modelFactory: () => model,
      fileSystemPort: createNodeFileSystemAdapter(),
      eventStore: createInMemorySessionEventStore(),
    });
  let runtime: AgentRuntime | undefined;
  try {
    await store.createSession({
      id: sessionID,
      projectID: "fixture" as ProjectId,
      directory: root,
      slug: "fixture",
      title: "fixture",
      version: "1",
    });
    await store.saveMessage({
      id: start,
      sessionID,
      role: "user",
      agent: "build",
      time: { created: 1 },
    });
    await store.savePart({
      id: "user_text" as PartId,
      sessionID,
      messageID: start,
      type: "text",
      text: "START_USER_FACT " + "durable fixture context ".repeat(1500) + " TAIL_USER_FACT",
    });
    await store.saveMessage({
      id: end,
      sessionID,
      role: "assistant",
      agent: "build",
      mode: "build",
      parentID: start,
      time: { created: 2, completed: 3 },
      path: { root, cwd: root },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      anchor: { turnId, orderedMessageIds: [start, end], boundaryMessageId: end },
    });
    await store.savePart({
      id: "assistant_text" as PartId,
      sessionID,
      messageID: end,
      type: "text",
      text: "FINAL_ASSISTANT_FACT",
    });
    runtime = createRuntime();
    await runtime.resumeFromStore();
    assert.equal(requests.length, 0, "cold resume cannot authorize paid historical learning");
    const input = { startMessageId: start, boundaryMessageId: end, turnId };
    await runtime.retryMemoryExtraction(input);
    await runtime.drainMemoryExtractions(null);
    assert.equal(requests.length, 3);
    assert.equal(successful.length, 2);
    runtime.beginShutdown();
    runtime = createRuntime();
    await runtime.resumeFromStore();
    assert.equal(requests.length, 3);
    fail = false;
    await runtime.retryMemoryExtraction(input);
    await runtime.drainMemoryExtractions(null);
    assert.ok(
      requests.length > 10,
      "context limits determine segment size, never logical coverage",
    );
    assert.match(successful.join(""), /START_USER_FACT/u);
    assert.match(successful.join(""), /TAIL_USER_FACT/u);
    assert.match(successful.join(""), /FINAL_ASSISTANT_FACT/u);
    assert.equal(requests.filter((text) => text === requests[0]).length, 1);
    const completedCount = requests.length;
    await runtime.retryMemoryExtraction(input);
    await runtime.drainMemoryExtractions(null);
    assert.equal(requests.length, completedCount);
  } finally {
    runtime?.beginShutdown();
    store.close();
    await rm(root, { force: true, recursive: true });
  }
});
