import { list, record, text } from "./common.js";

/** 只在 Google 边界识别已知耗尽格式；通用 429 继续由公共重试策略处理。 */
export async function normalizeGoogleQuotaResponse(response: Response): Promise<Response> {
  if (response.status !== 429 || !response.headers.get("content-type")?.includes("json"))
    return response;
  const clone = response.clone();
  const reader = clone.body?.getReader();
  if (!reader) return response;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 65536) return response;
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body = record(JSON.parse(new TextDecoder().decode(bytes)));
    const error = record(body.error);
    const exhausted = list(error.details).some((detail) => {
      const info = record(detail);
      return (
        info["@type"] === "type.googleapis.com/google.rpc.ErrorInfo" &&
        ["DAILY_QUOTA_EXCEEDED", "INSUFFICIENT_QUOTA", "QUOTA_EXHAUSTED"].includes(
          text(info.reason),
        )
      );
    });
    // 此兼容格式来自已确认现场；不能通过 Retry-After 长短猜测所有供应商的额度性质。
    if (!exhausted && !/^Individual quota reached\b/i.test(text(error.message))) return response;
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    void response.body?.cancel().catch(() => {});
    return Response.json(
      {
        ...body,
        error: {
          ...error,
          code: "exceeded_current_quota_error",
          type: "exceeded_current_quota_error",
        },
      },
      { status: response.status, headers },
    );
  } catch {
    return response;
  } finally {
    void reader.cancel().catch(() => {});
  }
}
