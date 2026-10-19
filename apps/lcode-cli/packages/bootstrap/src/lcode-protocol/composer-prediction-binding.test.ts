import assert from "node:assert/strict";
import test from "node:test";
import { generateWorkspaceText } from "./server-operations.js";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";

test("prediction binds the exact resident session and never creates a cold runtime", async () => {
  const workspace = { workspaceKey: "fixture-workspace", workspacePath: "/fixture-workspace" };
  const selection = { providerId: "fixture", modelId: "model" };
  const calls: unknown[] = [];
  const context = {
    sessions: new Map([
      [
        "first-other-session",
        {
          workspace,
          app: {
            generateWorkspaceText: async () =>
              assert.fail("Must not use the first workspace resident"),
          },
        },
      ],
      [
        "requested-session",
        {
          workspace,
          app: {
            generateWorkspaceText: async (input: unknown, options: unknown) => {
              calls.push({ input, options });
              return { text: "next input", selection, finishReason: "stop" };
            },
          },
        },
      ],
    ]),
    deps: { createSessionEventStore: () => assert.fail("Prediction must not create a runtime") },
  } as unknown as LCodeProtocolAgentServerContext;
  const params = {
    workspace,
    selection,
    querySource: "composer_prediction",
    composerPrediction: {
      sessionId: "requested-session",
      boundaryMessageId: "assistant-boundary",
    },
  };
  const signal = new AbortController().signal;
  assert.equal((await generateWorkspaceText(context, params, signal)).text, "next input");
  assert.deepEqual(calls, [
    {
      input: {
        selection,
        querySource: "composer_prediction",
        composerPrediction: params.composerPrediction,
      },
      options: { abortSignal: signal },
    },
  ]);
  await assert.rejects(
    generateWorkspaceText(context, {
      ...params,
      composerPrediction: { ...params.composerPrediction, sessionId: "cold-session" },
    }),
  );
  await assert.rejects(
    generateWorkspaceText(context, {
      ...params,
      workspace: { ...workspace, workspaceKey: "foreign-workspace" },
    }),
  );
  assert.equal(calls.length, 1);
});
