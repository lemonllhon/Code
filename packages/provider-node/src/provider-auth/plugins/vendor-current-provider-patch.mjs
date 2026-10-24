import { replacePinned, replacePinnedRegion } from "./vendor-source-patch.mjs";
import { patchQoderMessages } from "./vendor-qoder-session-patch.mjs";

/** 2026-10-24 固定升级后的本地边界；上游协议修复由原始快照提供，禁止重复注入旧补丁。 */
export function patchCurrentProvider(path, source) {
  if (path === "trae/index.mjs" || path === "commandcode/index.mjs") return source;
  if (path === "workbuddy/index.mjs") {
    // 401 仍可续期，但一份 Runner 许可不能借插件内部重发消耗第二次推理。
    source = replacePinned(
      source,
      "await res.body?.cancel().catch(() => {})\n              const r = await reissued",
      "const original = init?.routingSingleAttempt ? res : null\n              if (!original) await res.body?.cancel().catch(() => {})\n              const r = await reissued",
    );
    source = replacePinned(
      source,
      "sign(site, a, headers)\n              const again = await post(b)",
      'sign(site, a, headers)\n              if (original) return kept(original, "renewed")\n              const again = await post(b)',
    );
    source = replacePinned(
      source,
      "if (!r.a) return out(r.why, gone(a, r, invalidToken(res)), res)",
      "if (!r.a) { if (original) await original.body?.cancel().catch(() => {}); return out(r.why, gone(a, r, invalidToken(res)), res) }",
    );
    source = replacePinned(
      source,
      "if (res.status === 400) {\n              let text",
      "if (!init?.routingSingleAttempt && res.status === 400) {\n              let text",
    );
    return source;
  }
  if (path === "grok/index.mjs") {
    source = replacePinned(
      source,
      "await res.body?.cancel().catch(() => {})\n              await remember(auth, c)",
      "await remember(auth, c)\n              if (init?.routingSingleAttempt) return kept(res)\n              await res.body?.cancel().catch(() => {})",
    );
    return source;
  }
  if (path !== "qoder/index.mjs") return undefined;
  source = patchQoderMessages(source);
  // 普通 schema 400 不能被文本猜测升级为 502，否则会诱发无效重试；只保留上游结构化代码分类。
  source = replacePinned(
    source,
    'if (UPSTREAM_FAILED.test(msg)) return { status: 502, message: msg, signIn: "" }',
    'if (status >= 500 && UPSTREAM_FAILED.test(msg)) return { status: 502, message: msg, signIn: "" }',
  );
  source = replacePinned(
    source,
    'const key = createHash("sha256").update(JSON.stringify([sid, at, at < 0 ? null : msgs[at].content ?? null])).digest("hex")',
    'const key = String(chat.__lcode_task_key ?? "") || createHash("sha256").update(JSON.stringify([sid, at, at < 0 ? null : msgs[at].content ?? null])).digest("hex")',
  );
  // 会话必须来自 Host 关联；同提示词不能合并两个 workspace/remote session。
  source = replacePinnedRegion(
    source,
    'function sessionOf(chat, named = "") {',
    "// SESSION carries",
    `function sessionOf(chat, named = "") {
  const key = String(named || chat.prompt_cache_key || "").trim()
  if (!key) return randomUUID()
  const h = createHash("sha256").update("lcode-qoder-session\\0" + key).digest("hex")
  return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20,32)
}

`,
  );
  // 10605 的首次 busy 事实交给 Runner，不在 worker 中等待后重复派发。
  source = replacePinned(
    source,
    "if (!f?.queue || waited >= QUEUE.recoveries)",
    "if (init.routingSingleAttempt || !f?.queue || waited >= QUEUE.recoveries)",
  );
  return source;
}
