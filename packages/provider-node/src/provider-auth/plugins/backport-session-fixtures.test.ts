import assert from "node:assert/strict";
import test from "node:test";
import { account, fixture } from "./backport-test-support.js";
import { loadPatchedVendor } from "./vendor-test-support.js";
import type { AuthGrant } from "../driver.js";

const user = { role: "user", content: "fixture" };
const qoderGrant: AuthGrant = {
  type: "oauth",
  access: "fixture",
  refresh: "fixture",
  uid: "fixture-user",
  machineId: "fixture-machine",
  expires: Date.now() + 3600000,
};
for (const channel of ["qoder", "qoder-cn"])
  test(`${channel} bundled request preserves Host cache affinity without exposing session or repeating POST`, async (t) => {
    const { _internal: m } = await loadPatchedVendor("qoder/index.mjs");
    const f = await fixture(t, channel, ({ path }) =>
      path.includes("/model/list")
        ? { json: { chat: [{ key: "fixture", enable: true, max_input_tokens: 64000 }] } }
        : {
            status: 400,
            json: {
              message: "Error in upstream response: Invalid schema for function 'Git': type null",
            },
          },
    );
    const a = account(qoderGrant);
    const model = (await f.driver.models(a.context))[0]!;
    const sent = [];
    const identities = [
      ["fixture-workspace-a", null, "fixture-session"],
      ["fixture-workspace-a", null, "fixture-session"],
      ["fixture-workspace-b", null, "fixture-session"],
      ["fixture-workspace-a", "fixture-remote-a", "fixture-session"],
      ["fixture-workspace-a", "fixture-remote-b", "fixture-session"],
    ];
    for (const identity of identities) {
      const response = await f.driver.fetch(
        new Request(model.baseURL + "/chat/completions", {
          method: "POST",
          body: JSON.stringify({
            model: model.id,
            stream: true,
            prompt_cache_key: "untrusted-body-key",
            messages: [user],
          }),
        }),
        { ...a.context, requestSessionKey: JSON.stringify(identity) },
      );
      assert.equal(response.status, 400);
      assert.match(await response.text(), /Invalid schema/);
      const wire = f.calls.filter((x) => !x.path.includes("/model/list")).at(-1)!;
      assert.equal(wire.headers["x-lcode-session-id"], undefined);
      const decoded = m.decodeBody(wire.body);
      assert.doesNotMatch(
        decoded,
        /fixture-session|fixture-workspace|fixture-remote|untrusted-body-key/,
      );
      sent.push(JSON.parse(decoded));
    }
    assert.equal(sent[0].session_id, sent[1].session_id);
    assert.notEqual(sent[0].session_id, sent[2].session_id);
    assert.equal(new Set(sent.map((x) => x.session_id)).size, 4);
    assert.notEqual(sent[0].request_id, sent[1].request_id);
    assert.equal(sent[0].messages.at(-1).content.at(-1).cache_control.type, "ephemeral");
    assert.equal(f.calls.filter((x) => !x.path.includes("/model/list")).length, identities.length);
    assert.equal(a.writes.length, 0);
  });

for (const stream of [false, true])
  test(`Devin bundled usage-only fails before success (${stream}) with exactly one POST`, async (t) => {
    const { _internal: m } = await loadPatchedVendor("devin/index.mjs");
    const raw = m.frame(new m.PB().bytes(7, new m.PB().varint(2, 100).varint(3, 2).done()).done());
    const f = await fixture(t, "devin", () => ({
      headers: { "content-type": "application/connect+proto" },
      bytes: raw,
    }));
    const a = account({ type: "api", key: "fixture-key" });
    const model = (await f.driver.models(a.context)).find((item) => item.id === "swe-2")!;
    const response = await f.driver.fetch(
      new Request(model.baseURL + "/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "swe-2", stream, messages: [user] }),
      }),
      a.context,
    );
    assert.equal(response.status, 502);
    assert.match(await response.text(), /empty reply/);
    assert.equal(f.calls.filter((x) => x.path.includes("GetChatMessage")).length, 1);
    assert.equal(a.writes.length, 0);
  });
