import assert from "node:assert/strict";
import test from "node:test";
import { LCODE_AGENT_PROVIDER } from "@lcode/shared";
import { buildV4ConversationPromptTelemetryExtraDetail } from "./conversationPromptTelemetry.js";

test("普通供应商 prompt 遥测保留模型与运行时归属，不再发送套餐身份", () => {
  const detail = buildV4ConversationPromptTelemetryExtraDetail({
    agentProvider: LCODE_AGENT_PROVIDER,
    configProvider: "fixture-api-provider",
    modelName: "fixture-model",
    providerBaseURL: "https://provider.example.test/v1?secret=fixture",
    askMode: "agent",
  });
  assert.equal(detail.agent, LCODE_AGENT_PROVIDER);
  assert.equal(detail.model_provider, "fixture-api-provider");
  assert.equal(detail.provider_name, "provider.example.test");
  assert.equal(
    Object.keys(detail).some((key) => key.startsWith("plan_")),
    false,
  );
  assert.equal(
    Object.values(detail).some((value) => value.includes("secret=")),
    false,
  );
});
