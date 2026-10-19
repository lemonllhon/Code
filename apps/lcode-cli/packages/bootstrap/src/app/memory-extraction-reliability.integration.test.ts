import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNodeFileSystemAdapter, createSqliteSessionStore } from "@lcode/adapters";
import { AgentRuntime } from "@lcode/core";
import {
  createInMemorySessionEventStore,
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES,
  type MessageId,
  type MessageInfo,
  type MessagePart,
  type Model,
  type ModelRequest,
  type SessionId,
  type SessionTranscriptWindow,
  type MemoryReviewEvidencePage,
} from "@lcode/contracts";

const FACT = "Fixture tests use isolated databases.";
const LIMITS = {
  maxMessageRows: 256,
  maxPartRows: 1024,
  maxDataBytes: SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES,
};

for (const scenario of [
  "raw byte budget",
  "rewind cut outside window",
  "same-turn payload",
] as const) {
  test(`real cold Runtime/SQLite/CAS saves memory after ${scenario}`, async (t) => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "lcode-memory-reliable-"));
    const store = createSqliteSessionStore({ dbPath: join(root, "session.db") });
    const sessionId = "sess_reliable_fixture" as SessionId;
    const requests: ModelRequest[] = [];
    const windows: SessionTranscriptWindow[] = [];
    const pages: MemoryReviewEvidencePage[] = [];
    const failures: unknown[] = [];
    const model = {
      providerId: "fixture",
      modelId: "fixture",
      displayName: "Fixture",
      optionSpecs: { maxOutputTokens: { max: 8192 }, reasoningLevel: { values: ["low"] } },
      options: { maxOutputTokens: 8192, reasoningLevel: "low" },
      properties: {
        contextWindow: 1_000_000,
        inputFormat: { supportsText: true },
        supportsMidConversationSystem: true,
      },
      bind: () => model,
      generateText: async (request: ModelRequest) => {
        if (request.tools?.length)
          return { text: "Fixture complete.", finishReason: "stop", usage: {} };
        requests.push(request);
        const evidence = JSON.parse(String(request.messages[1]!.content));
        if (evidence.items)
          return {
            text: JSON.stringify({
              decisions: evidence.items.map((item: { itemId: string }) => ({
                itemId: item.itemId,
                accept: true,
                reason: "Explicit durable fixture constraint.",
              })),
            }),
            finishReason: "stop",
            usage: {},
          };
        return {
          text: JSON.stringify({
            summary: "Fixture fact",
            items: [
              {
                fileName: "testing.md",
                content: FACT,
                reason: "Explicit fixture constraint.",
                sourceIds: [evidence.sources[0].id],
              },
            ],
          }),
          finishReason: "stop",
          usage: {},
        };
      },
    } as unknown as Model;
    const config = {
      workingDirectory: root,
      workspacePath: root,
      mode: "yolo" as const,
      modelSelection: { providerId: "fixture", modelId: "fixture" },
      modelStreaming: "off" as const,
      memory: {
        enabled: true,
        use: true,
        storageLocation: "workspace" as const,
        cliStorageRoot: join(root, "profile", "cli"),
      },
      compact: { enabled: false },
      subagents: { enabled: false },
      mcp: { enabled: false },
      titleGeneration: { enabled: false },
      toolAllowlist: ["Read"],
    };
    const runtime = () =>
      new AgentRuntime(sessionId, config, {
        sessionStore: store,
        modelFactory: () => model,
        fileSystemPort: createNodeFileSystemAdapter(),
        eventStore: createInMemorySessionEventStore(),
      });
    const first = runtime();
    let cold: AgentRuntime | undefined;
    try {
      await first.ensureSessionPersistedForExternalActivity("Fixture");
      const oldId = "msg_old_cut" as MessageId;
      const old: MessageInfo = {
        id: oldId,
        sessionID: sessionId,
        role: "assistant",
        parentID: "msg_old_user" as MessageId,
        modelSelection: { providerId: "fixture", modelId: "fixture" },
        mode: "yolo",
        agent: "build",
        path: { cwd: root, root },
        time: { created: 1, completed: 2 },
        finish: "stop",
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0,
      } as MessageInfo;
      await store.saveMessage(old);
      if (scenario === "raw byte budget") {
        const parts: MessagePart[] = Array.from({ length: 120 }, (_, i) => ({
          id: `part_fixture_${i}_${"i".repeat(50)}`,
          messageID: oldId,
          sessionID: sessionId,
          type: "tool",
          tool: "Read",
          callID: `old_read_${i}`,
          state: {
            status: "completed",
            input: {},
            metadata: {},
            title: "Historical read",
            output: "OLD_TOOL_PAYLOAD" + "x".repeat(1000),
            time: { start: 1, end: 2 },
          },
        })) as MessagePart[];
        for (const part of parts) await store.savePart(part);
        const before = await store.readTranscriptWindow({
          sessionID: sessionId,
          throughMessageID: oldId,
          limits: LIMITS,
        });
        const desiredBytes = LIMITS.maxDataBytes - 16_000;
        const firstPart = parts[0]!;
        if (firstPart.type === "tool" && firstPart.state.status === "completed") {
          firstPart.state.output += "x".repeat(desiredBytes - before.loadedDataBytes);
        }
        await store.savePart(firstPart);
      } else if (scenario === "rewind cut outside window") {
        await store.setRevert({
          sessionID: sessionId,
          revert: {
            kind: "conversation_rewind",
            messageID: oldId,
            targetMessageID: oldId,
            branchCutAfterMessageID: oldId,
            keptMessageIDs: [],
            branchGeneration: 1,
          },
        });
        for (let i = 0; i < 300; i++)
          await store.saveMessage({ ...old, id: `msg_branch_${i}` as MessageId });
      }
      // 真正冷恢复，不能靠当前runtime的内存历史绕过SQLite窗口与分支元数据。
      cold = runtime();
      const internal = cold as unknown as {
        agentTelemetry: {
          detached: (input: unknown) => { finishFailed: (...args: unknown[]) => unknown };
        };
      };
      const detached = internal.agentTelemetry.detached.bind(internal.agentTelemetry);
      internal.agentTelemetry.detached = (input) => {
        const scope = detached(input);
        const finish = scope.finishFailed.bind(scope);
        scope.finishFailed = (...args) => {
          failures.push(args[2] instanceof Error ? args[2].stack : String(args[2]));
          return finish(...args);
        };
        return scope;
      };
      await cold.resumeFromStore();
      const readWindow = store.readTranscriptWindow.bind(store);
      const readEvidence = store.readMemoryReviewEvidence.bind(store);
      const saveMessage = store.saveMessage.bind(store);
      let injected = false;
      store.saveMessage = async (message, copyFrom) => {
        await saveMessage(message, copyFrom);
        if (
          scenario !== "same-turn payload" ||
          injected ||
          message.role !== "assistant" ||
          !message.time.completed
        )
          return;
        injected = true;
        await store.saveParts({
          sessionID: sessionId,
          messageID: message.id,
          parts: Array.from({ length: 2256 }, (_, i) => ({
            id: `part_long_${i}`,
            messageID: message.id,
            sessionID: sessionId,
            type: "reasoning",
            text: "INTERNAL_REASONING".repeat(100),
            time: { start: 1 },
          })) as MessagePart[],
        });
        await store.savePart({
          id: "part_huge_output",
          messageID: message.id,
          sessionID: sessionId,
          type: "tool",
          tool: "Read",
          callID: "fixture-read",
          state: {
            status: "completed",
            input: {},
            output: "SAME_TURN_TOOL".repeat(30_000),
            metadata: {},
            title: "fixture",
            time: { start: 1, end: 2 },
          },
        } as MessagePart);
      };
      const readMessages = store.messages.bind(store);
      let extractionStarted = false;
      store.readMemoryReviewEvidence = async (input) => {
        extractionStarted = true;
        const page = await readEvidence(input);
        pages.push(page);
        if (page.status !== "ready") {
          const boundary = await store.messageWithParts({
            sessionID: sessionId,
            messageID: input.throughMessageID as MessageId,
          });
          assert.fail(
            JSON.stringify({
              reason: page.reason,
              requestedTurn: input.turnId,
              anchorTurn: boundary?.info.anchor?.turnId,
              requestedStart: input.startMessageID,
              anchorStart: boundary?.info.anchor?.orderedMessageIds?.[0],
            }),
          );
        }
        return page;
      };
      store.readTranscriptWindow = async (input) => {
        extractionStarted = true;
        const window = await readWindow(input);
        windows.push(window);
        return window;
      };
      store.messages = async (...args) => {
        if (extractionStarted)
          throw new Error("No whole-history fallback during memory extraction");
        return readMessages(...args);
      };
      const completed = await cold.executeTurn(
        `Remember the durable fixture constraint: ${FACT}${scenario === "same-turn payload" ? " Additional durable fixture context.".repeat(5000) : ""}`,
        undefined,
        {
          abortSignal: t.signal,
        },
      );
      await (
        cold as unknown as { drainMemoryExtractions(timeout: null): Promise<void> }
      ).drainMemoryExtractions(null);
      assert.ok(
        requests.length >= 2,
        JSON.stringify({
          failures,
          pages: pages.map((page) => ({
            status: page.status,
            reason: page.reason,
            start: page.startMessageID,
            end: page.throughMessageID,
          })),
        }),
      );
      if (scenario === "same-turn payload") assert.ok(requests.length > 2);
      assert.ok(requests.every((r) => r.options!.maxOutputTokens === 4096));
      assert.equal(await readFile(join(root, ".lcode", "memory", "testing.md"), "utf8"), FACT);
      assert.doesNotMatch(
        JSON.stringify(requests),
        /OLD_TOOL_PAYLOAD|SAME_TURN_TOOL|INTERNAL_REASONING/u,
      );
      assert.ok(
        pages.length >= 5,
        "generator, verifier, commit and completion re-read versioned pages",
      );
      assert.ok(pages.every((page) => page.status === "ready"));
      const requestCount = requests.length;
      await cold.retryMemoryExtraction({
        startMessageId: pages[0]!.startMessageID,
        boundaryMessageId: pages[0]!.throughMessageID,
        turnId: completed.turnId,
      });
      await cold.drainMemoryExtractions(null);
      assert.equal(
        requests.length,
        requestCount,
        "explicit retries reuse durable segment consumption without another model call",
      );
      if (scenario === "same-turn payload") assert.ok(pages.some((page) => page.nextCursor));
      const last = pages.at(-1)!;
      windows.push(
        await readWindow({
          sessionID: sessionId,
          throughMessageID: last.throughMessageID as MessageId,
          limits: LIMITS,
        }),
      );
      if (scenario === "raw byte budget") {
        assert.ok(windows[0]!.loadedDataBytes <= LIMITS.maxDataBytes);
        assert.ok(Buffer.byteLength(JSON.stringify(windows[0]!.messages)) > LIMITS.maxDataBytes);
      } else if (scenario === "rewind cut outside window") {
        assert.equal(windows[0]!.prefixTruncated, true);
        assert.deepEqual(windows[0]!.branchCutBeforeWindow, {
          messageID: oldId,
          branchGeneration: 1,
        });
        assert.ok(!windows[0]!.messages.some((m) => m.info.id === oldId));
      }
    } finally {
      cold?.beginShutdown();
      first.beginShutdown();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
