import { readMonthlyQuotaReset } from "@lcode/provider";

/** 与内容拒绝共用原响应观察入口；先投影 reset，再让租约/Host 读取响应头。 */
export async function normalizeMonthlyQuotaResponse(response: Response): Promise<Response> {
  if (response.status !== 429) return response;
  const reader = response.clone().body?.getReader();
  if (!reader) return response;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 65_536) return response;
      chunks.push(part.value);
    }
    const resetAt = readMonthlyQuotaReset(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (resetAt === undefined) return response;
    const headers = new Headers(response.headers);
    for (const name of ["content-length", "content-encoding", "transfer-encoding"])
      headers.delete(name);
    headers.set("x-lcode-quota-reset-at", String(resetAt));
    headers.set("retry-after-ms", String(Math.max(0, resetAt - Date.now())));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return response;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
