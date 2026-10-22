import { replacePinned, replacePinnedRegion } from "./vendor-source-patch.mjs";
import { patchDevinToolImages } from "./vendor-devin-images-patch.mjs";
import { patchZedOrganization } from "./vendor-zed-organization-patch.mjs";
import { patchQoderSession } from "./vendor-qoder-session-patch.mjs";
import { patchDevinEmptyReply } from "./vendor-devin-empty-patch.mjs";
import {
  patchKiroApiKey,
  patchZedSystemTurns,
  patchDevinCompression,
} from "./vendor-followup-patch.mjs";
import { patchMiniMaxCheckin } from "./vendor-minimax-checkin-patch.mjs";

/** 来源为 plugins 5b68df0；原始 vendor 字节和其他供应商策略保持不变。 */
export function applyProviderCompatibility(path, source) {
  const known = new Set([
    "workbuddy/index.mjs",
    "factory/index.mjs",
    "qoder/index.mjs",
    "zen-free/tool-response.mjs",
    "zed/index.mjs",
    "devin/index.mjs",
    "grok/index.mjs",
    "kiro/index.mjs",
    "minimax/index.mjs",
    "trae/index.mjs",
  ]);
  if (!known.has(path)) return source;
  source = source.replaceAll("\r\n", "\n");
  if (path === "workbuddy/index.mjs")
    return replacePinned(
      source,
      '.toLowerCase().replace(/^x/, "")',
      '.toLowerCase().replace(/\\s+credits?$/, "").replace(/^x/, "")',
    );
  if (path === "zen-free/tool-response.mjs") {
    // null 是空增量；数字/对象仍交给原校验，不能吞掉真实协议错误。
    source = replacePinned(
      source,
      'if (key === "name" || key === "arguments") {',
      'if (key === "name" || key === "arguments") {\n      if (value == null) continue;',
    );
    // ID 与 function 分片一样是增量；空占位不能覆盖前面 choice/index 已确认的 ID。
    return replacePinned(
      source,
      "          if (fragment.function != null) appendFunction(value.function, fragment.function);",
      '          if (fragment.id == null || fragment.id === "") {\n            if (previous.id !== undefined) value.id = previous.id;\n            else delete value.id;\n          } else if (typeof fragment.id !== "string") throw new GuardError("Invalid upstream tool ID");\n          if (fragment.function != null) appendFunction(value.function, fragment.function);',
    );
  }
  if (path === "factory/index.mjs") {
    // 已有 Droid 前缀也必须去掉不支持的采样参数，不能因原来的 early return 跳过。
    source = replacePinned(
      source,
      "    const opened = promptOpenings(m.input)",
      `    const sampled = byId.get(m.model)?.upstream === "openai" && ("temperature" in m || "top_p" in m)
    if (sampled) { delete m.temperature; delete m.top_p }
    const opened = promptOpenings(m.input)`,
    );
    source = replacePinned(
      source,
      "else if (ins !== v || opened) m.instructions = ins",
      "else if (ins !== v || opened || sampled) m.instructions = ins",
    );
    // 厂商 billing 元数据只占首行，删除整个 block 会把用户任务指令一起丢掉。
    return replacePinned(
      source,
      'block.text?.startsWith("x-anthropic-billing-header: cc_version=")) {\n      changed = true\n      continue',
      'block.text?.startsWith("x-anthropic-billing-header: cc_version=")) {\n      changed = true\n      const end = block.text.indexOf("\\n")\n      const rest = end < 0 ? "" : block.text.slice(end + 1)\n      if (!rest.trim()) continue\n      block.text = rest',
    );
  }
  if (path === "qoder/index.mjs") {
    // 设备流由当前 worker 轮询，桌面 URL scheme 会在 macOS/Windows/Linux 抢走结果页。
    source = replacePinned(source, 'redirect: "qoder-app://",', 'redirect: "",');
    source = patchQoderSession(source);
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
  if (path === "kiro/index.mjs") return patchKiroApiKey(source);
  if (path === "trae/index.mjs") {
    // 新 CN 授权使用客户端设备格式；已保存的设备绑定保持，不能在签到时轮换身份。
    source = replacePinned(
      source,
      "const newDevice = () => ({ deviceId: digits(19),",
      'const newDevice = (site) => ({ deviceId: digits(site?.id === "trae-cn" ? 16 : 19),',
    );
    source = replacePinned(source, "const device = newDevice()", "const device = newDevice(site)");
    // 空快照不是推理内容，继续检查厂商其他已有字段（plugins 40d7c52）。
    source = replacePinned(
      source,
      'd.reasoning_content ?? d.reasoning ?? delta.reasoning_content ?? ""',
      '[d.reasoning_content, d.reasoning, delta.reasoning_content, delta.reasoning].find(v => typeof v === "string" && v) ?? ""',
    );
    source = replacePinned(
      source,
      "if (!o.name) o.name = c.name",
      "if (!o.name) o.name = c.name\n    else if (c.name && c.name.startsWith(o.name) && c.name !== o.name) o.name = c.name",
    );
    source = replacePinned(
      source,
      'e.message || "Trae CN returned an error"',
      'e.message || "Trae returned an error"',
    );
    return replacePinned(source, "`Trae CN: ${message}`", "`${site.realm}: ${message}`");
  }
  if (path === "minimax/index.mjs") return patchMiniMaxCheckin(source);
  if (path === "zed/index.mjs") return patchZedSystemTurns(patchZedOrganization(source));
  if (path === "devin/index.mjs")
    return patchDevinCompression(patchDevinEmptyReply(patchDevinToolImages(source)));
  if (path === "grok/index.mjs") {
    // 过滤工具后必须同步检查 choice；Grok 会拒绝没有 tools 的显式 none。
    source = replacePinned(
      source,
      `(!body.includes('"tools"') &&`,
      `(!body.includes('"tools"') && !body.includes('"tool_choice"') &&`,
    );
    return replacePinned(
      source,
      "  if (Array.isArray(m.input)) {",
      '  if (Object.hasOwn(m, "tool_choice") && !(Array.isArray(m.tools) && m.tools.length)) {\n    delete m.tool_choice\n    dirty = true\n  }\n  if (Array.isArray(m.input)) {',
    );
  }
  return source;
}
