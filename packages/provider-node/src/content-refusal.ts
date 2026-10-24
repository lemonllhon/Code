import { readContentRefusalCode } from "@lcode/provider";
import { normalizeMonthlyQuotaResponse } from "./monthly-quota.js";

/** 结构化内容拒绝在账号状态更新前统一投影为请求错误；原始状态与 body 保留。 */
export async function normalizeContentRefusalResponse(
  response: Response,
  channel?: string,
): Promise<Response> {
  if (response.status === 429) return normalizeMonthlyQuotaResponse(response);
  if (
    response.status !== 403 ||
    (channel === "factory" && response.headers.get("x-factory-upstream-error"))
  )
    return response;
  const clone = response.clone(),
    reader = clone.body?.getReader();
  if (!reader) return response;
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 64 * 1024) return response;
      chunks.push(next.value);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const code = readContentRefusalCode(JSON.parse(text));
    if (!code || (channel === "factory" && code !== "content_policy_rejected")) return response;
    const headers = new Headers(response.headers);
    for (const key of ["content-length", "content-encoding", "transfer-encoding"])
      headers.delete(key);
    headers.set("content-type", "application/json");
    headers.set("x-lcode-upstream-status", "403");
    // 原始 body 与 code 保留，Host/Runner 按确定的请求拒绝结束，不能切换账号继续提交。
    void response.body?.cancel().catch(() => {});
    return new Response(text, { status: 400, headers });
  } catch {
    return response;
  } finally {
    // tee 的原分支还由插件消费，不能等待另一分支的 cancel 而死锁。
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
