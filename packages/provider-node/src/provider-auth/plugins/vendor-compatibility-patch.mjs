import { replacePinned, replacePinnedRegion } from "./vendor-source-patch.mjs";
import { patchDevinToolImages } from "./vendor-devin-images-patch.mjs";
import { patchZedOrganization } from "./vendor-zed-organization-patch.mjs";

/** 来源为 plugins 5b68df0；原始 vendor 字节和其他供应商策略保持不变。 */
export function applyProviderCompatibility(path, source) {
  const known = new Set([
    "workbuddy/index.mjs",
    "factory/index.mjs",
    "qoder/index.mjs",
    "zen-free/tool-response.mjs",
    "zed/index.mjs",
    "devin/index.mjs",
  ]);
  if (!known.has(path)) return source;
  source = source.replaceAll("\r\n", "\n");
  if (path === "workbuddy/index.mjs")
    return replacePinned(
      source,
      '.toLowerCase().replace(/^x/, "")',
      '.toLowerCase().replace(/\\s+credits?$/, "").replace(/^x/, "")',
    );
  if (path === "zen-free/tool-response.mjs")
    // null 是空增量；数字/对象仍交给原校验，不能吞掉真实协议错误。
    return replacePinned(
      source,
      'if (key === "name" || key === "arguments") {',
      'if (key === "name" || key === "arguments") {\n      if (value == null) continue;',
    );
  if (path === "factory/index.mjs") {
    // 已有 Droid 前缀也必须去掉不支持的采样参数，不能因原来的 early return 跳过。
    source = replacePinned(
      source,
      "    const opened = promptOpenings(m.input)",
      `    const sampled = byId.get(m.model)?.upstream === "openai" && ("temperature" in m || "top_p" in m)
    if (sampled) { delete m.temperature; delete m.top_p }
    const opened = promptOpenings(m.input)`,
    );
    return replacePinned(
      source,
      "else if (ins !== v || opened) m.instructions = ins",
      "else if (ins !== v || opened || sampled) m.instructions = ins",
    );
  }
  if (path === "qoder/index.mjs") {
    // 仅已知 10605 可穿过 HTTP 包装；外层真实业务 code 仍具有优先级。
    source = replacePinnedRegion(
      source,
      "function failure(status, text) {",
      "  msg ||= STATUS_CODES[status]",
      `function failure(status, text) {
  if (status < 400 || status > 599) status = 502
  let msg = String(text ?? "").trim()
  let code = ""
  let queue
  try {
    let j = JSON.parse(msg)
    const outerCode = j?.code == null ? "" : String(j.code)
    if (["", "401", "403"].includes(outerCode) && typeof j?.message === "string") {
      try {
        const inner = JSON.parse(j.message.trim())
        if (inner && !Array.isArray(inner) && String(inner.code) === QUEUED) j = inner
      } catch {}
    }
    code = j?.code == null ? "" : String(j.code)
    if (j?.message) msg = String(j.message)
    const d = typeof j?.details === "string" ? JSON.parse(j.details.trim()) : j?.details
    if (d?.error?.message) msg += ": " + d.error.message
    queue = j?.queue && typeof j.queue === "object" ? j.queue : undefined
    if (!queue && typeof j?.message === "string" && j.message.trim().startsWith("{")) {
      const q = JSON.parse(j.message.trim())
      if (q && typeof q === "object" && ("isQueued" in q || "serviceAvailable" in q || "retryAfterSeconds" in q)) queue = q
    }
  } catch {}
`,
    );
    source = replacePinned(source, "chunk = JSON.parse(inner)", "chunk = JSON.parse(inner.trim())");
    return replacePinned(
      source,
      "return errorResponse({ status: 400, message: e.message })",
      "if (e instanceof SignInGone || e?.expired) return signedInError(e)\n      return errorResponse({ status: 502, message: e?.message ?? String(e) })",
    );
  }
  if (path === "zed/index.mjs") return patchZedOrganization(source);
  if (path === "devin/index.mjs") return patchDevinToolImages(source);
  return source;
}
