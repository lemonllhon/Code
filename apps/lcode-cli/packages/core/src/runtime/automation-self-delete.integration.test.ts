import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createSessionId,
  SessionEventType,
  type AutomationPort,
  type Model,
  type ModelTextRequest,
  type ModelTextResult,
  type SessionEvent,
} from "@lcode/contracts";
import { AgentRuntime } from "./agent-runtime.js";

for (const deliveryKind of ["desktop-continuous", "web-remote-replayable"] as const) {
  for (const streaming of ["off", "on"] as const) {
    test(
      `${deliveryKind} with ${streaming} streaming self-deletes and retains turn restrictions`,
      { timeout: 20000 },
      async (t) => {
        const root = await mkdtemp(join(tmpdir(), "lcode-self-delete-"));
        const deleted: string[] = [];
        const events: SessionEvent[] = [];
        let steps = 0;
        let userTurn = false;
        const next = (request: ModelTextRequest): ModelTextResult => {
          const names = request.tools?.map((tool) => tool.name) ?? [];
          assert.ok(names.includes("CronDelete"));
          assert.ok(names.includes("CronList"));
          assert.equal(names.includes("CronCreate"), userTurn);
          assert.equal(names.includes("CronUpdate"), userTurn);
          steps++;
          if (userTurn) {
            assert.ok(steps <= 5);
            return steps === 4
              ? {
                  text: "",
                  finishReason: "tool-calls",
                  usage: {},
                  toolCalls: [
                    { id: "user-delete", name: "CronDelete", input: { id: "automation-other" } },
                  ],
                }
              : { text: "deleted", finishReason: "stop", usage: {} };
          }
          assert.ok(steps <= 3);
          if (steps <= 2)
            return {
              text: "",
              finishReason: "tool-calls",
              usage: {},
              toolCalls: [
                {
                  id: `call-${steps}`,
                  name: "CronDelete",
                  input: {
                    id: steps === 1 ? "automation-self" : "automation-other",
                  },
                },
              ],
            };
          assert.match(JSON.stringify(request.messages), /only delete itself/i);
          return { text: "finished", finishReason: "stop", usage: {} };
        };
        const model = {
          providerId: "fixture",
          modelId: "fixture",
          options: {},
          optionSpecs: { maxOutputTokens: { max: 4096 }, reasoningLevel: { values: [] } },
          properties: {
            contextWindow: 128000,
            inputFormat: { supportsText: true },
            outputFormat: { supportsText: true },
            supportsToolCall: true,
            supportsMidConversationSystem: true,
          },
          generateText: async (request: ModelTextRequest) => next(request),
          streamText: async function* (request: ModelTextRequest) {
            const result = next(request);
            for (const toolCall of result.toolCalls ?? []) yield { type: "tool_call", toolCall };
            if (result.text) yield { type: "text_delta", text: result.text };
            yield { type: "finish", finishReason: result.finishReason, usage: result.usage };
          },
        } as unknown as Model;
        const port: AutomationPort = {
          create: async () => {
            throw new Error("forbidden create");
          },
          update: async () => {
            throw new Error("forbidden update");
          },
          list: async () => [],
          delete: async ({ id }) => {
            deleted.push(id);
            return true;
          },
        };
        const runtime = new AgentRuntime(
          createSessionId(),
          {
            clientMode: deliveryKind,
            deliveryKind,
            workingDirectory: root,
            mode: "yolo",
            modelSelection: { providerId: "fixture", modelId: "fixture" },
            compact: { enabled: false },
            memory: { enabled: false },
            mcp: { enabled: false },
            subagents: { enabled: false },
            titleGeneration: { enabled: false },
            modelStreaming: streaming,
            streamingToolExecution: streaming,
            toolAllowlist: ["CronCreate", "CronUpdate", "CronDelete", "CronList"],
            nativeSearchEnhancementsEnabled: false,
          },
          {
            modelFactory: () => model,
            automationPort: port,
            eventStore: {
              append: async (event: SessionEvent) => {
                const stored = { ...event, sequenceNumber: events.length + 1 };
                events.push(stored);
                return stored;
              },
              getEvents: async () => events,
            } as never,
          },
        );
        (
          runtime as unknown as { ensureContextInitialized: () => Promise<void> }
        ).ensureContextInitialized = async () => {};
        try {
          await runtime.executeTurn("finish and delete this automation", undefined, {
            automationId: "automation-self",
            abortSignal: t.signal,
          });
          assert.equal(steps, 3);
          assert.deepEqual(deleted, ["automation-self"]);
          userTurn = true;
          await runtime.executeTurn("delete another automation", undefined, {
            abortSignal: t.signal,
          });
          assert.equal(steps, 5);
          assert.deepEqual(deleted, ["automation-self", "automation-other"]);
          assert.equal(
            events.filter((event) => event.type === SessionEventType.TurnComplete).length,
            2,
          );
          assert.ok(events.every((event, i) => event.sequenceNumber === i + 1));
        } finally {
          await runtime.closeBrowserSession();
          await rm(root, { recursive: true, force: true });
        }
      },
    );
  }
}
