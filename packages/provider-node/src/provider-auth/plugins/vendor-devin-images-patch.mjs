import { replacePinned } from "./vendor-source-patch.mjs";

/** 移植 plugins 5b68df0 的工具图片关联；只转换厂商请求，不写原始 history。 */
export function patchDevinToolImages(source) {
  source = replacePinned(
    source,
    "function build(chat, uid, key) {",
    String.raw`function inlineImage(p) {
  if (p?.type !== "image_url") return null
  const u = typeof p.image_url === "string" ? p.image_url : p.image_url?.url ?? ""
  const d = /^data:([^,]*),(.*)$/s.exec(u)
  return d && d[2] ? { data: d[2], type: d[1].replace(/;base64$/, "") || "image/png" } : null
}
const FROM = "[From the result of "
function noted(text) {
  const m = /(?:\n\n)?\[The tool returned (an image; it|(\d+) images; they) follows? in the next message\.\]$/.exec(text)
  return m ? { n: m[2] ? Number(m[2]) : 1, text: text.slice(0, m.index) } : { n: 0, text }
}
function build(chat, uid, key) {`,
  );
  source = replacePinned(
    source,
    "  const system = []\n  for (const m of joinSplitCalls(chat.messages ?? [])) {",
    `  const system = []
  const results = new Map()
  const resultFor = (text) => {
    if (typeof text !== "string" || !text.startsWith(FROM)) return null
    for (const [id, r] of results) if (r.said.n > r.seen && (text === FROM + "tool call " + id + ":]" || text.endsWith(" (tool call " + id + "):]"))) return r
    return null
  }
  const settleResults = () => {
    for (const r of results.values()) {
      if (r.said.n > 0 && r.seen === r.said.n) r.msg.text = r.said.text
      r.msg.text ||= "(no output)"
    }
    results.clear()
  }
  for (const m of joinSplitCalls(chat.messages ?? [])) {`,
  );
  source = replacePinned(
    source,
    '    if (m.role === "assistant") {\n      const calls =',
    '    if (m.role !== "tool" && m.role !== "user") settleResults()\n    if (m.role === "assistant") {\n      const calls =',
  );
  source = replacePinned(
    source,
    `        let out = textOf(m.content) || "(no output)"
        msgs.push({ role: TOOL, callID: pending[i].id, text: out })`,
    `        const images = Array.isArray(m.content) ? m.content.map(inlineImage).filter(Boolean) : []
        const msg = { role: TOOL, callID: pending[i].id, text: textOf(m.content), images }
        msgs.push(msg)
        results.set(m.tool_call_id, { msg, said: noted(msg.text), seen: 0 })`,
  );
  source = replacePinned(
    source,
    `    } else
      for (const p of m.content ?? []) {
        if (p?.type === "text" && p.text) texts.push(p.text)
        else if (p?.type === "image_url") {
          const u = typeof p.image_url === "string" ? p.image_url : p.image_url?.url ?? ""
          const d = /^data:([^,]*),(.*)$/s.exec(u)
          if (d && d[2]) images.push({ data: d[2], type: d[1].replace(/;base64$/, "") || "image/png" })
        }
      }
    const text = texts.join("\\n\\n")`,
    `    } else {
      let to = null
      for (const p of m.content ?? []) {
        if (p?.type === "text") {
          to = results.size ? resultFor(p.text) : null
          if (!to && p.text) texts.push(p.text)
        } else if (p?.type === "image_url") {
          const im = inlineImage(p)
          if (to) {
            if (im) to.msg.images.push(im)
            if (++to.seen === to.said.n) to = null
          } else if (im) images.push(im)
        }
      }
    }
    settleResults()
    const text = texts.join("\\n\\n")`,
  );
  return replacePinned(
    source,
    "  answer()\n  const last = msgs[msgs.length - 1]",
    "  settleResults()\n  answer()\n  const last = msgs[msgs.length - 1]",
  );
}
