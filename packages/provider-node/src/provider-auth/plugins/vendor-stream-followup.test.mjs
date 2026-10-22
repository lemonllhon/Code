import assert from "node:assert/strict";
import test from "node:test";
import { loadPatchedVendor } from "./vendor-test-support.js";

test("Qoder browser device sign-in stays in browser for both regions", async () => {
  const m = await loadPatchedVendor("qoder/index.mjs");
  for (const create of [m.QoderAuthPlugin, m.QoderCNAuthPlugin]) {
    const hooks = await create({ client: {} });
    const challenge = await hooks.auth.methods[0].authorize();
    const url = new URL(challenge.url);
    assert.equal(url.searchParams.has("redirect_uri"), false);
    for (const key of ["challenge", "challenge_method", "nonce", "machine_id", "client_id"])
      assert.ok(url.searchParams.get(key));
  }
});

test("Trae empty reasoning field cannot hide a later meaningful reasoning field", async () => {
  const { parts } = await loadPatchedVendor("trae/index.mjs", ["parts"]);
  for (const data of [
    { reasoning_content: "", reasoning: "thought" },
    { reasoning_content: "", delta: { reasoning_content: "thought" } },
    { reasoning_content: "", delta: { reasoning: "thought" } },
  ]) {
    const events = (async function* () {
      yield { event: "output", data };
    })();
    const output = [];
    for await (const p of parts(events)) output.push(p);
    assert.equal(output.find((p) => p.reasoning)?.reasoning, "thought");
  }
});

test("Trae tool name snapshots grow without concatenating unrelated names", async () => {
  const {
    _internal: { NativeCalls },
  } = await loadPatchedVendor("trae/index.mjs");
  const calls = new NativeCalls();
  calls.push({ id: "fixture", function: { name: "G", arguments: '{"action":' } });
  calls.push({ id: "fixture", function: { name: "Git", arguments: '{"action":"status"}' } });
  calls.push({ id: "fixture", function: { name: "Other", arguments: "" } });
  const result = calls.take([]);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "Git");
});

test("Trae new browser devices use the site shape without changing existing accounts", async () => {
  const {
    _internal: { newDevice, SITES },
  } = await loadPatchedVendor("trae/index.mjs");
  assert.match(newDevice(SITES["trae-cn"]).deviceId, /^\d{16}$/);
  assert.match(newDevice(SITES["trae-global"]).deviceId, /^\d{19}$/);
});
