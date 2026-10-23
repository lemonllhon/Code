import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
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

for (const mode of ["local", "shared", "separate-executions"] as const)
  for (const knownQuota of [false, true])
    for (const querySource of ["main_turn", "subagent"])
      test(
        `SR-10 capacity admission: ${mode}, known=${knownQuota}, source=${querySource}`,
        { timeout: 15_000 },
        async (t) => {
          const directory = await mkdtemp(join(tmpdir(), "api-capacity-"));
          const held = new Map<string, ServerResponse>();
          const requests: string[] = [];
          const network = createServer((request, response) => {
            void (async () => {
              const chunks: Buffer[] = [];
              for await (const chunk of request) chunks.push(Buffer.from(chunk));
              const body = JSON.parse(Buffer.concat(chunks).toString()) as {
                messages: Array<{ content: string }>;
              };
              const tag = body.messages.at(-1)!.content;
              requests.push(tag);
              response.writeHead(200, {
                "content-type": "text/event-stream",
                ...(knownQuota
                  ? {
                      "x-ratelimit-remaining-requests": "1000",
                      "x-ratelimit-limit-requests": "1000",
                    }
                  : {}),
              });
              response.write(textFrame);
              if (tag === "waiting") response.end(finishFrame);
              else held.set(tag, response);
            })().catch((error: Error) => response.destroy(error));
          });
          network.listen(0, "127.0.0.1");
          await once(network, "listening");
          const address = network.address();
          assert.ok(address && typeof address !== "string");
          const parsed = createRegistryProviderConfig(
            parseProviderConfig({
              group: "standard-personal",
              api: {
                type: "openai-chat-completions",
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
              },
              access: {
                type: "api-key",
                apiKeys: [{ id: "fixture", apiKey: "synthetic", routing: { quotaPoolId: "team" } }],
              },
            }),
          );
          assert.ok(parsed.ok);
          const executions = Array.from(
            { length: mode === "separate-executions" ? 2 : 1 },
            () =>
              new AiSdkModelExecution(
                mode === "local" ? {} : { routingQuotaDirectory: directory },
                { transport: fetch },
              ),
          );
          const models = executions.map((execution) => {
            const bound = execution.bindModel({
              providerId: "fixture",
              modelId: "fixture",
              providerConfig: parsed.config,
              supportsJsonSchemaOutput: false,
              optionSpecs: { reasoningLevel: { map: "{}" }, maxOutputTokens: { map: "{}" } },
            });
            return () =>
              ({
                ...bound.resolveRequest({
                  options: { maxOutputTokens: 20, reasoningLevel: "none" },
                }),
                properties: {
                  contextWindow: 100,
                  inputFormat: { text: true },
                  outputFormat: { text: true },
                  supportsToolCall: true,
                },
              }) as unknown as ResolvedAiSdkModel;
          });
          const statuses: ModelNetworkStatusEvent[] = [];
          const controllers: AbortController[] = [];
          const jobs: Promise<unknown>[] = [];
          t.after(async () => {
            controllers.forEach((controller) => controller.abort());
            held.forEach((response) => response.destroy());
            await Promise.allSettled(jobs);
            await Promise.all(executions.map((execution) => execution.disposeAndWait()));
            network.closeAllConnections();
            await new Promise<void>((resolve) => network.close(() => resolve()));
            await rm(directory, { recursive: true, force: true });
          });
          const run = (tag: string, resolveModel = models[0]!, released?: () => void) => {
            const entered = Promise.withResolvers<void>();
            const controller = new AbortController();
            controllers.push(controller);
            const done = (async () => {
              let text = "";
              for await (const event of runStreamText({
                env: { LCODE_RUNTIME_ENV: "test" },
                modelIoFullRetentionEnabled: false,
                request: {
                  messages: [{ role: "user", content: tag }],
                  maxOutputTokens: 20,
                  abortSignal: controller.signal,
                  metadata: { querySource },
                  traceContext: createRootTraceContext({
                    sessionId: createSessionId(),
                    turnId: createTurnId(),
                  }),
                  ...(released
                    ? {
                        modelRequestAdmission: {
                          tryAcquire: () => ({ publish() {}, release: released }),
                          async acquire() {
                            return { publish() {}, release: released };
                          },
                        },
                      }
                    : {}),
                },
                resolveModel,
                resolved: resolveModel(),
                runtime: defaultRuntime,
                retry: {
                  maxAttempts: 2,
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
                  entered.resolve();
                }
                assert.notEqual(event.type, "error");
              }
              return text;
            })();
            void done.catch(() => undefined);
            jobs.push(done);
            return { done, entered: entered.promise, controller };
          };
          const owners = [run("held-0")];
          await owners[0]!.entered;
          if (knownQuota && mode !== "separate-executions") {
            owners.push(run("held-1"));
            await owners[1]!.entered;
          }
          const outside = Promise.withResolvers<void>();
          const waiting = run("waiting", models.at(-1)!, outside.resolve);
          await outside.promise;
          await immediate();
          assert.equal(
            statuses.filter((event) => event.type === "model_retry_scheduled").length,
            0,
            "local concurrency is admission, not a failed model request",
          );
          assert.equal(requests.includes("waiting"), false);
          held.get("held-0")!.end(finishFrame);
          assert.equal(await waiting.done, "ok");
          for (const response of held.values()) response.end(finishFrame);
          assert.deepEqual(
            await Promise.all(owners.map(({ done }) => done)),
            owners.map(() => "ok"),
          );
          assert.equal(requests.filter((tag) => tag === "waiting").length, 1);
          assert.equal(
            statuses.filter((event) => event.type === "model_retry_scheduled").length,
            0,
          );
        },
      );
