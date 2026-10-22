import assert from "node:assert/strict";
import test from "node:test";
import type { Logger } from "@lcode/contracts";
import { installLCodeProtocolAiSdkWarningLogger } from "./ai-sdk-warning-logger.js";
test("SDK warnings cannot leak full history and are bounded regardless of provider payload", () => {
  let captured: unknown;
  const target = globalThis as typeof globalThis & { AI_SDK_LOG_WARNINGS?: unknown };
  const previous = target.AI_SDK_LOG_WARNINGS;
  try {
    installLCodeProtocolAiSdkWarningLogger({
      warn(_message: string, context: unknown) {
        captured = context;
      },
    } as Logger);
    const log = target.AI_SDK_LOG_WARNINGS as (options: unknown) => void;
    log({
      model: "fixture",
      provider: "fixture",
      warnings: Array.from({ length: 1000 }, () => ({
        type: "other",
        feature: "private-fixture-content",
        message: "private-fixture-content".repeat(10000),
        details: { messages: "private-fixture-content" },
      })),
    });
    const json = JSON.stringify(captured);
    assert.equal(json.includes("private-fixture-content"), false);
    assert.ok(json.length < 4000);
    assert.equal((captured as { warningCount: number }).warningCount, 1000);
  } finally {
    target.AI_SDK_LOG_WARNINGS = previous;
  }
});
