import assert from "node:assert/strict";
import test from "node:test";
import { DefaultLogRedactor } from "./serialize.js";
test("redaction keeps finite usage counters and missing values while protecting credentials", () => {
  const output = new DefaultLogRedactor().redact({
    inputTokens: 17,
    outputTokens: 0,
    totalTokens: undefined,
    reasoningTokens: 3,
    accessToken: "fixture-secret",
    apiKey: "fixture-secret",
    input_tokens: 4,
    maxOutputTokens: "fixture-secret",
    output_tokens: Infinity,
  });
  assert.deepEqual(output, {
    inputTokens: 17,
    outputTokens: 0,
    totalTokens: undefined,
    reasoningTokens: 3,
    accessToken: "[Redacted]",
    apiKey: "[Redacted]",
    input_tokens: 4,
    maxOutputTokens: "[Redacted]",
    output_tokens: "[Redacted]",
  });
});
