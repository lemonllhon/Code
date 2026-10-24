import assert from "node:assert/strict";
import test from "node:test";
import { readMonthlyQuotaReset, MAX_MONTHLY_QUOTA_DELAY_MS } from "../src/quota-reset.js";
import { readRateLimitHint, RateLimitWindow, MAX_RATE_LIMIT_DELAY_MS } from "../src/rate-limit.js";

const now = Date.UTC(2026, 9, 24);
const body = (at = "2026-10-31 23:59:59 +0800 CST.", code = "AccountQuotaExceeded") => ({
  error: { code, message: `You have exceeded the monthly usage quota. It will reset at ${at}` },
});
test("monthly quota parses Ark numeric offset without guessing CST or accepting unrelated errors", () => {
  const expected = Date.UTC(2026, 9, 31, 15, 59, 59);
  assert.equal(readMonthlyQuotaReset(body(), now), expected);
  assert.equal(readMonthlyQuotaReset(body("2026-10-31 23:59:59 UTC+8,"), now), expected);
  assert.equal(
    readMonthlyQuotaReset(body("2026-10-31 23:59:59 UTC-5,"), now),
    Date.UTC(2026, 10, 1, 4, 59, 59),
  );
  for (const date of [
    "2026-10-31 23:59:59 CST.",
    "2026-10-31 23:59:59.",
    "2026-02-30 23:59:59 +0800 CST.",
    "2026-10-31 24:00:00 +0800 CST.",
    "2026-10-31 23:59:59 UTC+15,",
    "2026-10-20 23:59:59 +0800 CST.",
    "2026-12-31 23:59:59 +0800 CST.",
  ])
    assert.equal(readMonthlyQuotaReset(body(date), now), undefined, date);
  assert.equal(readMonthlyQuotaReset(body(undefined, "invalid_request"), now), undefined);
  assert.equal(
    readMonthlyQuotaReset(
      { error: { code: "AccountQuotaExceeded", message: "a date 2026-10-31 23:59:59 +0800 CST." } },
      now,
    ),
    undefined,
  );
  assert.equal(
    readMonthlyQuotaReset(
      {
        error: {
          code: "AccountQuotaExceeded",
          message: body().error.message.replace("monthly", "daily"),
        },
      },
      now,
    ),
    undefined,
  );
});
test("only explicit future monthly reset permits a cooldown longer than ordinary rate limits", () => {
  const resetAt = Date.now() + 9 * 86400000;
  const hint = readRateLimitHint(
    new Headers({ "x-lcode-quota-reset-at": String(resetAt), "retry-after-ms": "99999999999" }),
  );
  const window = new RateLimitWindow(() => 0);
  window.extend(hint.delayMs, hint.resetAt);
  assert.ok(window.remainingMs() > MAX_RATE_LIMIT_DELAY_MS);
  assert.ok(window.remainingMs() <= MAX_MONTHLY_QUOTA_DELAY_MS);
  assert.equal(
    readRateLimitHint(new Headers({ "retry-after-ms": "99999999999" })).delayMs,
    MAX_RATE_LIMIT_DELAY_MS,
  );
  assert.equal(
    readRateLimitHint(
      new Headers({ "x-lcode-quota-reset-at": String(resetAt + MAX_MONTHLY_QUOTA_DELAY_MS) }),
    ).delayMs,
    1000,
  );
  window.dispose();
});
