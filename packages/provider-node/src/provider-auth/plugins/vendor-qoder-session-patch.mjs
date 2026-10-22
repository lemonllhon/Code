import { replacePinned, replacePinnedRegion } from "./vendor-source-patch.mjs";

/** 借鉴 plugins 7ee60f8；只投影请求，不能把未知结果配给已有明确 ID 的调用。
 * 单独处理孤立结果仍会留下悬空调用，因此在同一轮次投影中结算两侧，不伪造执行结果。
 */
export function patchQoderSession(source) {
  source = replacePinnedRegion(
    source,
    "function qoderMessages(msgs) {",
    "// windowFor is",
    String.raw`function qoderMessages(msgs) {
  const out = []
  const names = Object.create(null)
  let seen = [], turn = null
  const closeTurn = () => {
    if (!turn) return
    const unmatched = turn.message.tool_calls.filter((c) => turn.open.includes(c.id))
    if (unmatched.length) {
      turn.message.content += "\n\n[Previous tool call without a matched result: " + JSON.stringify(unmatched) + "]"
      const matched = turn.message.tool_calls.filter((c) => !turn.open.includes(c.id))
      if (matched.length) turn.message.tool_calls = matched
      else delete turn.message.tool_calls
    }
    turn = null
  }
  const showSeen = () => {
    if (seen.length) out.push({ role: "user", content: seen })
    seen = []
  }
  for (const [i, m] of msgs.entries()) {
    if (m.role !== "tool") closeTurn()
    if (m.role === "system" || m.role === "developer") continue
    if (m.role !== "user" && m.role !== "tool") showSeen()
    if (m.role === "tool") {
      let txt = textOf(m.content)
      const ims = Array.isArray(m.content) ? m.content.filter((p) => p?.type === "image_url").map(imageBlock).filter(Boolean) : []
      const named = String(m.tool_call_id ?? "").trim()
      const at = named ? turn?.open.indexOf(named) ?? -1 : -1
      const pick = named && turn?.used.has(named) ? -1 : at >= 0 ? at : turn ? turn.open.findIndex((id) => !turn.kept.has(id) && (!named || turn.missing.has(id))) : -1
      if (pick < 0) {
        if (txt.trim() || ims.length) seen.push({ type: "text", text: "[Previous unmatched tool result; call_id=" + (named || "unknown") + "]: " + txt }, ...ims)
        continue
      }
      const answered = turn.open.splice(pick, 1)[0]
      turn.used.add(answered)
      if (named) turn.used.add(named)
      turn.missing.delete(answered)
      if (ims.length) {
        const name = names[answered] || m.name
        const of = (name ? name + " (tool call " + answered + ")" : "tool call " + answered)
        seen.push({ type: "text", text: "[From the result of " + of + ":]" }, ...ims)
        const note = ims.length === 1 ? "[The tool returned an image; it follows in the next message.]" : "[The tool returned " + ims.length + " images; they follow in the next message.]"
        txt = txt.trim() ? txt + "\n\n" + note : txt + note
      }
      out.push({ role: "tool", tool_call_id: answered, content: txt })
      continue
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      const missing = new Set()
      const calls = m.tool_calls.map((c, k) => {
        const args = c.function?.arguments
        const said = typeof args === "string" ? args : JSON.stringify(args ?? {})
        const own = String(c.id ?? "").trim()
        const id = own || "call_" + createHash("sha256").update(JSON.stringify([i, k, c.function?.name, said])).digest("hex").slice(0, 32)
        if (!own) missing.add(id)
        names[id] = c.function?.name
        return { id, type: "function", function: { name: c.function?.name, arguments: said } }
      })
      const message = { role: "assistant", content: textOf(m.content), tool_calls: calls }
      out.push(message)
      const open = calls.map((c) => c.id), kept = new Set()
      for (let j = i + 1; j < msgs.length && msgs[j].role === "tool"; j++) {
        const id = String(msgs[j].tool_call_id ?? "").trim()
        if (open.includes(id)) kept.add(id)
      }
      turn = { open, kept, missing, message, used: new Set() }
      continue
    }
    let blocks = blocksOf(m.content)
    if (m.role === "assistant") blocks = blocks.filter((b) => b.type === "text")
    if (!blocks.length) continue
    if (m.role === "user" && seen.length) [blocks, seen] = [[...seen, ...blocks], []]
    out.push({ role: m.role, content: blocks })
  }
  closeTurn()
  showSeen()
  return out
}

`,
  );
  // 没有明确会话事实时不按提示词猜身份；同内容的新会话必须隔离。
  source = replacePinned(
    source,
    "function qoderBody(chat, m) {",
    String.raw`function cacheMarked(msgs) {
  const out = msgs.map((m) => m.role === "user" && Array.isArray(m.content) ? { ...m, contents: m.content } : m)
  const last = out.at(-1)
  if (last?.role !== "user" || !Array.isArray(last.content)) return out
  const excluded = new Set(["thinking", "redacted_thinking", "tool_use", "tool_result"])
  const at = last.content.findLastIndex((b) => b?.type && !excluded.has(b.type))
  if (at < 0) return out
  const content = last.content.slice()
  content[at] = { ...content[at], cache_control: { type: "ephemeral" } }
  out[out.length - 1] = { ...last, content, contents: content }
  return out
}
function sessionOf(chat) {
  const key = typeof chat.prompt_cache_key === "string" ? chat.prompt_cache_key.trim() : ""
  if (!key) return randomUUID()
  const h = createHash("sha256").update("lcode-qoder-session\0" + key).digest("hex")
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20, 32)
}
function qoderBody(chat, m) {`,
  );
  source = replacePinned(
    source,
    "  const body = {\n    parameters: params,",
    "  const request = randomUUID()\n  const body = {\n    request_id: request,\n    request_set_id: request,\n    chat_record_id: request,\n    session_id: sessionOf(chat),\n    parameters: params,",
  );
  source = replacePinned(
    source,
    "...qoderMessages(chat.messages ?? [])",
    "...cacheMarked(qoderMessages(chat.messages ?? []))",
  );
  source = replacePinned(
    source,
    '    paths.push(join(local, "Programs", "Qoder", "resources", "umid", name))',
    '    paths.push(join(local, "Programs", "Qoder", "resources", "umid", name))\n    for (const dir of [env.ProgramFiles || env.PROGRAMFILES, env.ProgramW6432]) if (dir) paths.push(join(dir, "Qoder", "resources", "umid", name))',
  );
  // 路径输入沿用原测试端口，macOS 的系统 Applications 也可注入，避免读取测试机真实安装。
  source = replacePinned(
    source,
    'opt = "/opt" } = {})',
    'opt = "/opt", applications = "/Applications" } = {})',
  );
  return replacePinned(
    source,
    '["/Applications", join(home, "Applications")]',
    '[applications, join(home, "Applications")]',
  );
}
