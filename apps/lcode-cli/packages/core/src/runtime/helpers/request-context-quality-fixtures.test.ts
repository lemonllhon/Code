import assert from "node:assert/strict";
import test from "node:test";
import { makeRequestContextQualityFixtures } from "../../../scripts/request-context-quality-fixtures.js";

test("paired model probes differ only in background overlays and preserve synthetic tools and explicit requests", () => {
  const bundle = makeRequestContextQualityFixtures();
  assert.equal(bundle.cases.length, 12);
  assert.equal(bundle.syntheticOnly, true);
  for (const item of bundle.cases) {
    const messages = [item.baseline, item.gitOnly, item.optimized];
    for (const arm of messages) {
      assert.deepEqual(arm.slice(0, 5), item.baseline.slice(0, 5));
      assert.equal(arm.filter((message) => message.toolCallId === "fixture-read").length, 1);
      assert.match(JSON.stringify(arm), /silently|Compare user-approved/);
    }
    if (item.scenario === "reference-layout") {
      assert.ok(JSON.stringify(item.optimized).length < JSON.stringify(item.baseline).length * 0.7);
      for (const text of ["不要修改账号鉴权", "不要改变登录流程", "仅限移动端", "八像素"])
        assert.ok(JSON.stringify(item.optimized).includes(text));
    }
    if (item.scenario === "explicit-confirm")
      assert.match(JSON.stringify(item.optimized), /fixture-alice/);
    if (item.scenario === "account-changed")
      assert.match(JSON.stringify(item.optimized), /fixture-bob/);
  }
});
