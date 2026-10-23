import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeLCodePluginId,
  canonicalizeLCodePluginConfigRecord,
  lcodePluginIdAliases,
  resolveLCodePluginStorageId,
  LCODE_CUA_OFFICIAL_PLUGIN_ID,
} from "./plugin-identity.js";

test("Computer Use aliases converge while other marketplace identities stay isolated", () => {
  const canonical = "computer-use@lcode-plugins-official";
  assert.equal(LCODE_CUA_OFFICIAL_PLUGIN_ID, canonical);
  assert.deepEqual(lcodePluginIdAliases(canonical), [
    canonical,
    "computer-use@zcode-plugins-official",
    "zcode-cua@zcode-plugins-official",
  ]);
  for (const id of lcodePluginIdAliases(canonical)) {
    assert.equal(canonicalizeLCodePluginId(id), canonical);
    assert.equal(resolveLCodePluginStorageId(id), "computer-use@zcode-plugins-official");
  }
  for (const id of [
    "computer-use@personal",
    "browser-use@zcode-plugins-official",
    "zcode-cua@lcode-plugins-official",
  ]) {
    assert.equal(canonicalizeLCodePluginId(id), id);
    assert.equal(resolveLCodePluginStorageId(id), id);
  }
});

test("canonical config wins, including false, without losing unrelated settings", () => {
  const old = "computer-use@zcode-plugins-official";
  const oldest = "zcode-cua@zcode-plugins-official";
  const current = LCODE_CUA_OFFICIAL_PLUGIN_ID;
  const input = { [oldest]: true, [old]: true, [current]: false, "third@personal": true };
  const result = canonicalizeLCodePluginConfigRecord(input);
  assert.deepEqual(result, { [current]: false, "third@personal": true });
  assert.deepEqual(canonicalizeLCodePluginConfigRecord(result), result);
  assert.equal(input[old], true);
  assert.deepEqual(canonicalizeLCodePluginConfigRecord({ [oldest]: "a", [old]: "b" }), {
    [current]: "b",
  });
});
