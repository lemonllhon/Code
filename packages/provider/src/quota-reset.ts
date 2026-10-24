const MONTHLY_CODES = new Set([
  "accountquotaexceeded",
  "quotaexceeded",
  "allocationquota.exceeded",
  "quota_exceeded",
  "insufficient_quota",
  "1310",
]);
export const MAX_MONTHLY_QUOTA_DELAY_MS = 35 * 86_400_000;

/** 只解析明确月度配额拒绝中的完整数字时区；CST 本身不能证明是哪个时区。 */
export function readMonthlyQuotaReset(value: unknown, now = Date.now()): number | undefined {
  if (!value || typeof value !== "object") return;
  const root = value as Record<string, unknown>;
  const error =
    root.error && typeof root.error === "object" ? (root.error as Record<string, unknown>) : root;
  if (!MONTHLY_CODES.has(String(error.code ?? root.code ?? "").toLowerCase())) return;
  const message = String(error.message ?? error.msg ?? root.message ?? root.msg ?? "");
  if (!/\bmonthly\b|月度|每月|本月/i.test(message)) return;
  const m =
    /(?:resets? at|将在|将于)\s*(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})\s*(?:(?:UTC|GMT)([+-])(\d{1,2})(?::?(\d{2}))?|([+-])(\d{2})(\d{2})\s+[A-Z]{2,5})(?:\s*(?:重置|[,.;，。；]))/i.exec(
      message,
    );
  if (!m) return;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const offsetHours = Number(m[8] ?? m[11]);
  const offsetMinutes = Number(m[9] ?? m[12] ?? 0);
  if (offsetHours > 14 || offsetMinutes > 59) return;
  const date = new Date(Date.UTC(year!, month! - 1, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  )
    return;
  const sign = (m[7] ?? m[10]) === "-" ? -1 : 1;
  const reset = date.getTime() - sign * (offsetHours * 60 + offsetMinutes) * 60_000;
  return reset > now && reset - now <= MAX_MONTHLY_QUOTA_DELAY_MS ? reset : undefined;
}
