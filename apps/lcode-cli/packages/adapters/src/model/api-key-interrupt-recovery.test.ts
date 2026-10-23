import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createRootTraceContext,
  createSessionId,
  createTurnId,
  type ModelNetworkStatusEvent,
} from "@lcode/contracts";
import { createRegistryProviderConfig, parseProviderConfig } from "@lcode/provider";
import { AiSdkModelExecution } from "./model-execution.js";
import { runStreamText } from "./runner-stream.js";
import { defaultRuntime, type ResolvedAiSdkModel } from "./runner-runtime.js";

const textFrame =
  'data: {"id":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n';
const finishFrame =
  'data: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n';

for (const shared of [false, true])
  for (const actors of [0, 1, 2])
    test(
      `SR-08 real HTTP + SDK: success / interrupt / next input (shared=${shared}, other actors=${actors})`,
      { timeout: 15_000 },
      async () => {
        const directory = await mkdtemp(join(tmpdir(), "api-interrupt-recovery-"));
        const held = new Map<string, ServerResponse>();
        const requests: string[] = [];
        const usedKeys = new Set<string | undefined>();
        const secondClosed = Promise.withResolvers<void>();
        const network = createServer((request, response) => {
          void (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const body = JSON.parse(Buffer.concat(chunks).toString()) as {
              messages: Array<{ content: string }>;
            };
            const tag = body.messages.at(-1)!.content;
            requests.push(tag);
            usedKeys.add(request.headers.authorization);
            response.writeHead(200, {
              "content-type": "text/event-stream",
              // 有明确额度读数时同一 Key 允许原有的两个并发槽；不修改生产并发策略。
              ...(actors === 1
                ? { "x-ratelimit-remaining-requests": "1000", "x-ratelimit-limit-requests": "1000" }
                : {}),
            });
            response.write(textFrame);
            if (tag === "first" || tag === "third") response.end(finishFrame);
            else {
              held.set(tag, response);
              if (tag === "second") response.on("close", () => secondClosed.resolve());
            }
          })().catch((error: unknown) =>
            response.destroy(error instanceof Error ? error : new Error(String(error))),
          );
        });
        network.listen(0, "127.0.0.1");
        await once(network, "listening");
        const address = network.address();
        assert.ok(address && typeof address !== "string");
        const provider = createRegistryProviderConfig(
          parseProviderConfig({
            group: "standard-personal",
            api: {
              type: "openai-chat-completions",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
            },
            access: {
              type: "api-key",
              apiKeys: Array.from({ length: actors === 1 ? 1 : actors + 1 }, (_, index) => ({
                id: `fixture-${index}`,
                apiKey: `synthetic-${index}`,
                enabled: true,
                routing: { quotaPoolId: "team" },
              })),
            },
          }),
        );
        assert.ok(provider.ok, JSON.stringify(provider));
        const execution = new AiSdkModelExecution(
          shared ? { routingQuotaDirectory: directory } : {},
          { transport: fetch },
        );
        const bound = execution.bindModel({
          providerId: "fixture",
          modelId: "fixture",
          providerConfig: provider.config,
          supportsJsonSchemaOutput: false,
          optionSpecs: { reasoningLevel: { map: "{}" }, maxOutputTokens: { map: "{}" } },
        });
        const resolveModel = () =>
          ({
            ...bound.resolveRequest({ options: { maxOutputTokens: 20, reasoningLevel: "none" } }),
            properties: {
              contextWindow: 100,
              inputFormat: { text: true },
              outputFormat: { text: true },
              supportsToolCall: true,
            },
          }) as unknown as ResolvedAiSdkModel;
        const statuses: ModelNetworkStatusEvent[] = [];
        const mainSession = createSessionId();
        const controls: AbortController[] = [];
        const run = (tag: string, visible?: () => void) => {
          const controller = new AbortController();
          controls.push(controller);
          const done = (async () => {
            let text = "";
            for await (const event of runStreamText({
              env: { LCODE_RUNTIME_ENV: "test" },
              modelIoFullRetentionEnabled: false,
              request: {
                messages: [{ role: "user", content: tag }],
                maxOutputTokens: 20,
                abortSignal: controller.signal,
                traceContext: createRootTraceContext({
                  sessionId: tag.startsWith("other") ? createSessionId() : mainSession,
                  turnId: createTurnId(),
                }),
              },
              resolveModel,
              resolved: resolveModel(),
              runtime: defaultRuntime,
              retry: {
                maxAttempts: 3,
                baseDelayMs: 0,
                maxDelayMs: 0,
                backoffFactor: 1,
                jitter: false,
              },
              streamIdleTimeoutMs: 10_000,
              statusSink: {
                publish(event) {
                  statuses.push(event);
                },
              },
            })) {
              if (event.type === "text_delta") {
                text += event.text;
                visible?.();
              }
              assert.notEqual(event.type, "error");
            }
            return text;
          })();
          void done.catch(() => undefined);
          return { controller, done };
        };
        const others: Array<ReturnType<typeof run>> = [];
        try {
          assert.equal(await run("first").done, "ok");
          assert.equal(
            execution
              .readApiKeyRoutingDiagnostics("fixture")!
              .items.reduce((sum, item) => sum + item.inFlight, 0),
            0,
          );
          for (let index = 0; index < actors; index++) {
            const entered = Promise.withResolvers<void>();
            others.push(run(`other-${index}`, entered.resolve));
            await entered.promise;
          }
          const entered = Promise.withResolvers<void>();
          const second = run("second", entered.resolve);
          await entered.promise;
          second.controller.abort(new DOMException("fixture immediate handoff", "AbortError"));
          await assert.rejects(
            second.done,
            (error: unknown) =>
              (error as { context?: { reason?: string } }).context?.reason === "cancelled",
          );
          assert.equal(
            execution
              .readApiKeyRoutingDiagnostics("fixture")!
              .items.reduce((sum, item) => sum + item.inFlight, 0),
            actors,
          );
          await secondClosed.promise;
          assert.equal(await run("third").done, "ok");
          for (let index = 0; index < actors; index++) held.get(`other-${index}`)!.end(finishFrame);
          assert.deepEqual(
            await Promise.all(others.map(({ done }) => done)),
            Array(actors).fill("ok"),
          );
          assert.equal(requests.filter((tag) => tag === "second").length, 1);
          assert.equal(requests.filter((tag) => tag === "third").length, 1);
          assert.equal(requests.length, 3 + actors);
          if (actors === 1)
            assert.equal(usedKeys.size, 1, "both concurrent actors use the same API Key");
          assert.equal(
            statuses.filter((event) => event.type === "model_retry_scheduled").length,
            0,
          );
          assert.equal(
            execution
              .readApiKeyRoutingDiagnostics("fixture")!
              .items.reduce((sum, item) => sum + item.inFlight, 0),
            0,
          );
        } finally {
          controls.forEach((controller) => controller.abort());
          held.forEach((response) => response.destroy());
          await Promise.allSettled(others.map(({ done }) => done));
          await execution.disposeAndWait();
          network.closeAllConnections();
          await new Promise<void>((resolve) => network.close(() => resolve()));
          await rm(directory, { recursive: true, force: true });
        }
      },
    );
