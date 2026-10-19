import assert from "node:assert/strict";
import test from "node:test";
import { selectMemoryExcerpt } from "./excerpt.js";

test("normalized combining sequences retain their original offset in a long paragraph", () => {
  const excerpt = selectMemoryExcerpt(
    `${"unrelated ".repeat(1200)}cafe\u0301 deployment constraints remain active.`,
    ["café"],
    240,
  );
  assert.ok(excerpt.includes("cafe\u0301"));
});

test("late body evidence and its adjacent restriction survive a bounded excerpt", () => {
  const prefix = "Unrelated introduction.\n\n".repeat(250);
  const restriction = "Do not apply this outside the mobile workspace.";
  const fact = "reconnect_lease must preserve pending input.";
  const result = selectMemoryExcerpt(
    `${prefix}${restriction}\n\n${fact}\n\nVerification passed.`,
    ["reconnect_lease"],
    4000,
  );
  assert.ok(result.length <= 4000);
  assert.ok(result.includes(fact));
  assert.ok(result.includes(restriction));
});

test("short memories stay complete and metadata-only matches keep the prefix", () => {
  assert.equal(selectMemoryExcerpt("A complete fact.", ["fact"], 40), "A complete fact.");
  assert.equal(selectMemoryExcerpt("abcdefghij", ["metadata"], 5), "abcde");
});

test("normalization and surrogate boundaries preserve useful text", () => {
  const body = "噪声\n\n".repeat(200) + "不要在其他项目使用。\n\nＦｏｏＢａｒ 的适用条件 😀。";
  const result = selectMemoryExcerpt(body, ["foobar"], 80);
  assert.ok(result.includes("ＦｏｏＢａｒ"));
  assert.ok(result.includes("不要在其他项目使用"));
  assert.ok(!/[\uD800-\uDBFF]$/u.test(result));
  assert.equal(selectMemoryExcerpt("😀abcd", [], 1), "");
});
