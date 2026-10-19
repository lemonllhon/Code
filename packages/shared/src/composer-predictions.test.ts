import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsSchema } from "./validationAppSettings.js";
import {
  lcodeWorkspaceGenerateTextParamsSchema,
  lcodeWorkspaceGenerateTextResultSchema,
} from "./lcode-protocol/index.js";
import {
  COMPOSER_PREDICTION_QUERY_SOURCE,
  composerPredictionResponseSchema,
} from "./composer-predictions.js";

test("auxiliary results retain the adapter's cache-write reporting evidence with strict validation", () => {
  const result = {
    text: "next input",
    selection: { providerId: "fixture", modelId: "model" },
    finishReason: "stop",
  };
  for (const reported of [false, true]) {
    const parsed = lcodeWorkspaceGenerateTextResultSchema.parse({
      ...result,
      usage: { inputTokens: 50, outputTokens: 20, cacheWriteTokensReported: reported },
    });
    assert.equal(parsed.usage?.cacheWriteTokensReported, reported);
  }
  assert.equal(
    lcodeWorkspaceGenerateTextResultSchema.safeParse({
      ...result,
      usage: { cacheWriteTokensReported: "false" },
    }).success,
    false,
  );
  assert.equal(
    lcodeWorkspaceGenerateTextResultSchema.safeParse({ ...result, usage: { unknownUsage: 1 } })
      .success,
    false,
  );
});

test("composer prediction is opt-in and cannot accept arbitrary tools, prompts or a budget", () => {
  assert.equal(appSettingsSchema.parse({}).composerPredictionsEnabled, false);
  const input = {
    workspace: { workspaceKey: "fixture", workspacePath: "/fixture" },
    selection: { providerId: "fixture", modelId: "model" },
    querySource: COMPOSER_PREDICTION_QUERY_SOURCE,
    composerPrediction: { sessionId: "session", boundaryMessageId: "message" },
  };
  assert.equal(lcodeWorkspaceGenerateTextParamsSchema.safeParse(input).success, true);
  for (const extra of [
    { prompt: "run something" },
    { messages: [{ role: "user", content: "x" }] },
    { tools: [] },
    { maxOutputTokens: 1000 },
  ])
    assert.equal(
      lcodeWorkspaceGenerateTextParamsSchema.safeParse({ ...input, ...extra }).success,
      false,
    );
  assert.equal(
    lcodeWorkspaceGenerateTextParamsSchema.safeParse({
      ...input,
      composerPrediction: undefined,
      prompt: "x",
    }).success,
    false,
  );
  assert.equal(
    composerPredictionResponseSchema.safeParse({ suggestion: "Next\nline" }).success,
    false,
  );
  assert.equal(
    composerPredictionResponseSchema.safeParse({ suggestion: "", approved: true }).success,
    false,
  );
});
