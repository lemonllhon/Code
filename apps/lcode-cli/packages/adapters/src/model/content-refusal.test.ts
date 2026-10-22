import assert from "node:assert/strict";
import test from "node:test";
import { readContentRefusalCode } from "@lcode/provider";
import { classifyModelFailure } from "./failure-classifier.js";
import {
  createProviderBusinessErrorFetch,
  readProviderBusinessFailureFromBody,
} from "./model-execution.js";

for (const code of [
  "content_filter",
  "content_policy_rejected",
  "content_policy_violation",
  "cyber_policy",
  "bio_policy",
])
  test(`structured ${code} is terminal in SDK HTTP, SSE and Responses failed objects`, async () => {
    for (const body of [
      { error: { code } },
      { code },
      {
        type: "response.failed",
        response: { status: "failed", error: { code, message: "fixture refusal" } },
      },
    ]) {
      assert.equal(readContentRefusalCode(body), code);
      assert.equal(readProviderBusinessFailureFromBody(body)?.statusCode, 400);
      for (const stream of [false, true]) {
        const fetcher = createProviderBusinessErrorFetch({
          providerId: "fixture",
          providerKind: "openai",
          fetch: async () =>
            stream
              ? new Response(`data: ${JSON.stringify(body)}\n\n`, {
                  headers: { "content-type": "text/event-stream" },
                })
              : Response.json(body, { status: 403 }),
        });
        let error: unknown;
        try {
          await (await fetcher("https://fixture.invalid", { method: "POST" })).text();
        } catch (failure) {
          error = failure;
        }
        assert.ok(error);
        const result = classifyModelFailure(error);
        assert.equal(result.retryable, false);
        assert.equal(result.reason, "invalid_request");
      }
    }
    assert.equal(readContentRefusalCode({ error: { message: code } }), undefined);
    assert.equal(readContentRefusalCode({ response: { output: [{ code }] } }), undefined);
  });
