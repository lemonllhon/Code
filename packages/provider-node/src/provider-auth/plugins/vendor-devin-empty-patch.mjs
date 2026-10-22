import { replacePinned, replacePinnedRegion } from "./vendor-source-patch.mjs";

/** usage 不是模型内容；在成功头之前检查，重试仍归原 Runner，不能在这里重发 POST。 */
export function patchDevinEmptyReply(source) {
  // async generator.return 会排在 pending read 后；先取消 reader，才能真正中断等待并归还句柄。
  source = replacePinnedRegion(
    source,
    "async function* frames(body) {",
    "// ---- the request",
    String.raw`function frames(body) {
  if (!body) return (async function* () {})()
  const reader = body.getReader()
  let released = false
  const iterator = (async function* () {
    let buf = new Uint8Array(0)
    try {
      for (;;) {
        while (buf.length >= 5) {
          const n = new DataView(buf.buffer, buf.byteOffset).getUint32(1)
          if (n > 64 << 20) throw new Error("a malformed stream")
          if (buf.length < 5 + n) break
          const flags = buf[0]
          let data = buf.slice(5, 5 + n)
          buf = buf.slice(5 + n)
          if (flags & 1) data = new Uint8Array(gunzipSync(data))
          yield { end: !!(flags & 2), data }
        }
        const { value, done } = await reader.read()
        if (done) {
          if (buf.length) throw new Error("unexpected EOF")
          return
        }
        const next = new Uint8Array(buf.length + value.length)
        next.set(buf); next.set(value, buf.length); buf = next
      }
    } finally {
      try { await reader.cancel() }
      finally { released = true; reader.releaseLock() }
    }
  })()
  return {
    next: () => iterator.next(),
    async return() {
      try { if (!released) await reader.cancel() }
      finally { await iterator.return() }
      return { done: true }
    },
    [Symbol.asyncIterator]() { return this },
  }
}

`,
  );
  source = replacePinned(
    source,
    "  if (!usage.output) usage.output = Math.floor((said + 3) / 4)",
    '  if (!said && tools < 0) {\n    yield { error: { status: 502, message: "an empty reply (Devin returned no text, reasoning or tool call)" } }\n    return\n  }\n  if (!usage.output) usage.output = Math.floor((said + 3) / 4)',
  );
  source = replacePinnedRegion(
    source,
    "  let replay = first",
    '  const id = "chatcmpl-"',
    String.raw`  // 首个有效事件到达前不发布 200；原帧迭代器最终必须归还 reader。
  const source = events((async function* () { yield first.value; yield* fr })())
  let head
  try { head = await source.next() }
  catch (e) { await fr.return?.(); return errorResponse({ status: 502, message: "the reply broke off: " + e.message }) }
  if (head.done || head.value.error) {
    await source.return?.()
    await fr.return?.()
    return errorResponse(head.value?.error ?? { status: 502, message: "an empty reply" })
  }
  const it = (async function* () {
    try { yield head.value; yield* source }
    finally { await source.return?.(); await fr.return?.() }
  })()
`,
  );
  source = replacePinned(
    source,
    "  if (first.value.end) {",
    "  if (first.value.end) {\n    await fr.return?.()",
  );
  source = replacePinned(
    source,
    "        ctl.close()\n      }\n    },\n    cancel() {",
    "        await it.return?.()\n        ctl.close()\n      }\n    },\n    cancel() {",
  );
  return replacePinned(
    source,
    "    cancel() {\n      it.return?.()\n    },",
    "    async cancel() {\n      await fr.return?.()\n      await it.return?.()\n    },",
  );
}
