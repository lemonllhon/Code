import { replacePinned, replacePinnedRegion } from "./vendor-source-patch.mjs";

/** GetProfile 仅提供区域提示；API Key 的控制面不能依赖可选 profile。来源 plugins 2039678。 */
export function patchKiroApiKey(source) {
  source = replacePinnedRegion(
    source,
    "// profileOf finds",
    "  if (c.builderID)",
    CONTROL_SOURCE + "async function profileOf(c) {\n",
  );
  source = replacePinned(
    source,
    "function usageLimits(a, email) {",
    'function usageLimits(a, email) {\n  if (a.tokenType === "API_KEY") return controlCall(a.region, a, "AmazonCodeWhispererService.GetUsageLimits", { origin: "KIRO_CLI" }, { origin: "KIRO_CLI" })',
  );
  source = replacePinned(
    source,
    "      if (!c.profile) {\n        c.profile = await profileOf(c)",
    '      if (c.method === "apikey") {\n        if (!c.asked) { c.profile = await keyProfile(c); c.asked = true }\n      } else if (!c.profile) {\n        c.profile = await profileOf(c)',
  );
  source = replacePinned(
    source,
    "profile: c.profile, region: regionOf(c.profile, c.region)",
    'profile: c.method === "apikey" ? "" : c.profile, region: regionOf(c.profile, c.region)',
  );
  source = replacePinned(source, "// listModels is", MODELS_SOURCE + "// listModels is");
  return replacePinned(
    source,
    'const out = await managementCall(a.region, a, "List-Available-Models", { origin: "KIRO_CLI", profileArn: a.profile })',
    'const out = a.tokenType === "API_KEY" ? await keyModels(a) : await managementCall(a.region, a, "List-Available-Models", { origin: "KIRO_CLI", profileArn: a.profile })',
  );
}

/** Zed 只接受 user/assistant；通知留在原位置，tool_result 仍在用户块首部。来源 plugins 3d355d3。 */
export function patchZedSystemTurns(source) {
  source = replacePinned(source, "// providerRequest is", SYSTEM_SOURCE + "// providerRequest is");
  // 原 providerRequest 还会补 is_error，先克隆请求，不能反向修改运行时 transcript。
  return replacePinned(
    source,
    'function providerRequest(wire, req, model) {\n  switch (wire) {\n    case "anthropic": {',
    'function providerRequest(wire, req, model) {\n  switch (wire) {\n    case "anthropic": {\n      req = structuredClone(req)\n      if (Array.isArray(req.messages)) req.messages = withoutSystemTurns(req.messages)',
  );
}

/** 大请求沿用同一 Connect POST；压缩正文和帧标记必须一起切换。来源 plugins 4fd68ba。 */
export function patchDevinCompression(source) {
  source = replacePinned(
    source,
    'import { gunzipSync } from "node:zlib"',
    'import { gunzipSync, gzip } from "node:zlib"\nimport { promisify } from "node:util"',
  );
  source = replacePinned(
    source,
    "// frame wraps",
    String.raw`const gzipRequest = promisify(gzip)
async function encodeConnectRequest(message) {
  const compressed = message.byteLength > 8192
  const payload = compressed ? await gzipRequest(message) : message
  const body = Buffer.from(frame(payload))
  body[0] = compressed ? 1 : 0
  return { body, headers: compressed ? { "Connect-Content-Encoding": "gzip" } : {} }
}

// frame wraps`,
  );
  source = replacePinned(
    source,
    "    res = await fetch(server + CHAT_RPC, {",
    "    const encoded = await encodeConnectRequest(build(chat, uid, key))\n    res = await fetch(server + CHAT_RPC, {",
  );
  source = replacePinned(
    source,
    'headers: { "Content-Type": "application/connect+proto", "Connect-Protocol-Version": "1", Authorization: "Basic " + key },',
    'headers: { "Content-Type": "application/connect+proto", "Connect-Protocol-Version": "1", Authorization: "Basic " + key, ...encoded.headers },',
  );
  return replacePinned(source, "body: frame(build(chat, uid, key)),", "body: encoded.body,");
}

const CONTROL_SOURCE = String.raw`async function controlCall(region, a, target, body, query) {
  const res = await fetch(management(region) + "/" + (query ? "?" + new URLSearchParams(query) : ""), {
    method: "POST",
    headers: { ...authHeaders(a), "Content-Type": "application/x-amz-json-1.0", "X-Amz-Target": target,
      "x-amzn-codewhisperer-optout": "false" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  if (!res.ok) throw new KiroError(res.status, text)
  return JSON.parse(text)
}

// KEY_REGIONS are where kiro-cli asks GetProfile for an API key's profile,
// in its order (the GovCloud and ISO ones after them aren't Kiro's
// subscriptions).
const KEY_REGIONS = ["us-east-1", "eu-central-1"]

// keyProfile is an API key's profile, as kiro-cli finds it: GetProfile in
// each region until one answers with a profile. kiro-cli goes on without
// one when every region turns it down (a key from an account with no
// CodeWhisperer profile answers 400), and so does this: "" then, and the
// key's calls are made in us-east-1 without a profile, as kiro-cli makes
// them (Hollowhere, on magpie's Discord: a key kiro-cli 2.33.1 served
// failed every request here with "Kiro didn't take the API key: 400").
async function keyProfile(c) {
  for (const region of KEY_REGIONS) {
    try {
      const arn = (await controlCall(region, { token: c.access, tokenType: "API_KEY" }, "AmazonCodeWhispererService.GetProfile", {}))
        ?.profile?.arn
      if (arn) return arn
    } catch {}
  }
  return ""
}

`;
const MODELS_SOURCE = String.raw`async function keyModels(a) {
  const out = { models: [] }
  let next
  for (let i = 0; i < 20; i++) {
    const page = await controlCall(a.region, a, "KiroControlPlaneBearerService.ListAvailableModels",
      { origin: "KIRO_CLI", ...(next ? { nextToken: next } : {}) }, { origin: "KIRO_CLI" })
    out.models.push(...(page?.models ?? []))
    out.defaultModel ??= page?.defaultModel
    next = page?.nextToken
    if (!next) break
  }
  return out
}

`;
const SYSTEM_SOURCE = String.raw`function systemBlocks(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : []
  if (!Array.isArray(content)) return []
  return content.filter((b) => b && typeof b === "object" && !(b.type === "text" && !b.text))
}

function asBlocks(content) {
  if (Array.isArray(content)) return content
  if (typeof content === "string" && content) return [{ type: "text", text: content }]
  return []
}

function withoutSystemTurns(messages) {
  if (!messages.some((m) => m?.role === "system")) return messages
  const out = []
  let pending = [] // system text waiting for the user message after it
  for (const m of messages) {
    if (m?.role === "system") {
      const blocks = systemBlocks(m.content)
      if (!blocks.length) continue
      const prev = out.at(-1)
      if (prev?.role === "user" && !pending.length) prev.content = [...asBlocks(prev.content), ...blocks]
      else pending.push(...blocks)
      continue
    }
    if (pending.length) {
      if (m?.role === "user") {
        const c = asBlocks(m.content)
        let i = 0
        while (i < c.length && c[i]?.type === "tool_result") i++
        out.push({ ...m, content: [...c.slice(0, i), ...pending, ...c.slice(i)] })
        pending = []
        continue
      }
      out.push({ role: "user", content: pending })
      pending = []
    }
    out.push(m)
  }
  if (pending.length) {
    const prev = out.at(-1)
    if (prev?.role === "user") prev.content = [...asBlocks(prev.content), ...pending]
    else out.push({ role: "user", content: pending })
  }
  return out
}

`;
