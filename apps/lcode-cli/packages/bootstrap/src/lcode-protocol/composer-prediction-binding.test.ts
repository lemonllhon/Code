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
      workspace: {
        ...workspace,
        workspaceKey: "foreign-workspace",
        workspaceIdentity: "foreign-workspace",
      },
    }),
  );
  assert.equal(calls.length, 1);
});

test("prediction accepts worktree origin and rejects foreign identity and attachment", async () => {
  const execution = {
    workspacePath: "/worktree",
    workspaceIdentity: "execution",
    workspaceKey: "execution",
    originWorkspacePath: "/origin",
    originWorkspaceIdentity: "origin",
    remoteSessionId: "attachment-a",
  };
  let calls = 0;
  const context = {
    sessions: new Map([
      [
        "session",
        {
          workspace: execution,
          app: {
            generateWorkspaceText: async () => {
              calls++;
              return {
                text: "next",
                selection: { providerId: "fixture", modelId: "model" },
                finishReason: "stop",
              };
            },
          },
        },
      ],
    ]),
    deps: { createSessionEventStore: () => assert.fail("No cold runtime") },
  } as unknown as LCodeProtocolAgentServerContext;
  const params = {
    workspace: {
      workspacePath: "/origin",
      workspaceIdentity: "origin",
      workspaceKey: "origin",
      remoteSessionId: "attachment-a",
    },
    selection: { providerId: "fixture", modelId: "model" },
    querySource: "composer_prediction",
    composerPrediction: { sessionId: "session", boundaryMessageId: "boundary" },
  };
  assert.equal((await generateWorkspaceText(context, params)).text, "next");
  await assert.rejects(
    generateWorkspaceText(context, {
      ...params,
      workspace: { ...params.workspace, workspaceIdentity: "foreign", workspaceKey: "foreign" },
    }),
    /unavailable/,
  );
  await assert.rejects(
    generateWorkspaceText(context, {
      ...params,
      workspace: { ...params.workspace, remoteSessionId: "attachment-b" },
    }),
    /unavailable/,
  );
  assert.equal(calls, 1);
});
