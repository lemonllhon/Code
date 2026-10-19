import assert from "node:assert/strict";
import test from "node:test";
import {
  createRootTraceContext,
  getCurrentModelInvocationContext,
  type Model,
  type ModelOptions,
  type ModelRequest,
  type ModelInvocationContext,
} from "@lcode/contracts";
import { SessionEventType } from "@lcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { generateWorkspaceText } from "./workspace-generate-text.js";

test("worktree naming uses the governed auxiliary model without changing the foreground model", async () => {
  const bindings: ModelOptions[] = [];
  let request: ModelRequest | undefined;
  let invocation: ModelInvocationContext | undefined;
  const model = {
    providerId: "fixture",
    modelId: "model",
    properties: {},
    optionSpecs: {
      reasoningLevel: { values: ["low", "high"] },
      maxOutputTokens: { max: 1024 },
      speed: { values: ["normal", "fast"] },
    },
    options: { reasoningLevel: "high", speed: "fast" },
    bind: (options: ModelOptions) => {
      bindings.push(options);
      return model;
    },
    generateText: async (input: ModelRequest) => {
      request = input;
      invocation = getCurrentModelInvocationContext();
      return { text: '{"title":"清理帮助入口"}', finishReason: "stop" };
    },
  } as unknown as Model;
  const admission = { acquire: async () => ({ publish: () => {}, release: () => {} }) };
  const operation = {
    run: (fn: () => Promise<unknown>) => fn(),
    setResultType: () => {},
    finishCompleted: () => {},
    finishFailed: () => {},
    finishCancelled: () => {},
  };
  const runtime = {
    config: {},
    sessionId: "naming-resource",
    rootTraceContext: createRootTraceContext(),
    modelFactory: () => model,
    modelRequestAdmission: admission,
    agentTelemetry: { detached: () => operation },
    createEvent: () => ({}),
    appendEvent: async () => {},
    createModelStatusSink: () => undefined,
    extractToolCallsFromResult: () => [],
  } as unknown as AgentRuntimeInternal;
  const signal = new AbortController().signal;
  const result = await generateWorkspaceText.call(
    runtime,
    {
      selection: { providerId: "fixture", modelId: "model" },
      messages: [{ role: "user", content: "请概括相关界面清理任务" }],
      tools: [],
      querySource: "worktree_task_name",
    },
    { abortSignal: signal },
  );
  assert.equal(result.text, '{"title":"清理帮助入口"}');
  assert.deepEqual(bindings, [{ reasoningLevel: "low", speed: "normal", maxOutputTokens: 1024 }]);
  assert.deepEqual(model.options, { reasoningLevel: "high", speed: "fast" });
  assert.equal(request?.abortSignal, signal);
  assert.deepEqual(request?.tools, []);
  assert.equal(invocation?.modelRequestAdmission, admission);
  assert.equal(invocation?.traceContext?.traceId, runtime.rootTraceContext.traceId);
});

test("unaccepted composer prediction text stays out of durable model events while usage remains", async () => {
  const events: Array<{ type: unknown; payload: Record<string, unknown> }> = [];
  let request: ModelRequest | undefined;
  const model = {
    providerId: "fixture",
    modelId: "model",
    properties: {},
    optionSpecs: { reasoningLevel: { values: ["low"] }, maxOutputTokens: { max: 1024 } },
    options: {},
    bind: () => model,
    generateText: async (value: ModelRequest) => {
      request = value;
      return {
        text: '{"suggestion":"PRIVATE_UNACCEPTED_SUGGESTION"}',
        finishReason: "stop",
        usage: { inputTokens: 20, outputTokens: 5 },
      };
    },
  } as unknown as Model;
  const operation = {
    run: (fn: () => Promise<unknown>) => fn(),
    setResultType: () => {},
    finishCompleted: () => {},
    finishFailed: () => {},
    finishCancelled: () => {},
  };
  const runtime = {
    config: {},
    sessionId: "fixture",
    rootTraceContext: createRootTraceContext(),
    modelFactory: () => model,
    modelRequestAdmission: { acquire: async () => ({ publish: () => {}, release: () => {} }) },
    agentTelemetry: { detached: () => operation },
    createEvent: (type: unknown, payload: Record<string, unknown>) => ({ type, payload }),
    appendEvent: async (event: (typeof events)[number]) => {
      events.push(event);
    },
    createModelStatusSink: () => undefined,
    extractToolCallsFromResult: () => [],
  } as unknown as AgentRuntimeInternal;
  await generateWorkspaceText.call(runtime, {
    selection: { providerId: "fixture", modelId: "model" },
    querySource: "composer_prediction",
    messages: [{ role: "user", content: "PRIVATE_CURRENT_TURN" }],
    tools: [],
    maxOutputTokens: 256,
  });
  assert.ok(JSON.stringify(request).includes("PRIVATE_CURRENT_TURN"));
  assert.ok(!JSON.stringify(events).includes("PRIVATE_"));
  assert.deepEqual(
    events.find((event) => event.type === SessionEventType.ModelComplete)?.payload.usage,
    { inputTokens: 20, outputTokens: 5 },
  );
});
