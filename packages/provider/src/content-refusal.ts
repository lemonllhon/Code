// 只认结构化厂商码，不能把用户消息中出现的 policy/refusal 词语当成错误。
const CONTENT_REFUSAL_CODES = [
  "content_filter",
  "content_policy_violation",
  "content_policy_rejected",
  "cyber_policy",
  "bio_policy",
] as const;
export type ContentRefusalCode = (typeof CONTENT_REFUSAL_CODES)[number];
const codes = new Set<string>(CONTENT_REFUSAL_CODES);

export function isContentRefusalCode(value: unknown): value is ContentRefusalCode {
  return typeof value === "string" && codes.has(value);
}

/** 公共 HTTP/AI SDK/SSE 错误投影；不解析 message 或任意 output 内容。 */
export function readContentRefusalCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const body = value as Record<string, unknown>;
  const response =
    body.response && typeof body.response === "object"
      ? (body.response as Record<string, unknown>)
      : undefined;
  const responseError = response?.status === "failed" ? response.error : undefined;
  for (const item of [responseError, body.error, body]) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (isContentRefusalCode(record.code)) return record.code;
    if (isContentRefusalCode(record.type)) return record.type;
  }
  return undefined;
}
