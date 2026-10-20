import assert from "node:assert/strict";
import test from "node:test";
import { PluginSingleAttempt } from "./single-attempt.js";

test("one permitted Qoder request retains normalized busy instead of the raw 403", () => {
  const gate = new PluginSingleAttempt("qoder");
  gate.claim("POST", "/v1/chat/completions");
  gate.observe(403, new Headers());
  const response = new Response("busy", { status: 503, headers: { "retry-after": "13" } });
  assert.equal(gate.preserve(response), response);
  assert.equal(gate.preserve(response).headers.get("retry-after"), "13");
});

test("a forbidden second inference still returns the first physical failure", async () => {
  const gate = new PluginSingleAttempt("qoder");
  gate.claim("POST", "/v1/chat/completions");
  gate.observe(429, new Headers({ "retry-after": "9" }));
  assert.throws(() => gate.claim("POST", "/v1/chat/completions"), /single attempt exhausted/);
  const response = gate.preserve(new Response("not dispatched", { status: 502 }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "9");
  await response.body?.cancel();
});

test("other providers preserve their first physical status and Retry-After", async () => {
  const gate = new PluginSingleAttempt("cursor");
  gate.claim("POST", "/agent.v1.AgentService/Run");
  gate.observe(503, new Headers({ "retry-after": "7" }));
  const response = gate.preserve(new Response("normalized", { status: 429 }));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "7");
  await response.body?.cancel();
});
