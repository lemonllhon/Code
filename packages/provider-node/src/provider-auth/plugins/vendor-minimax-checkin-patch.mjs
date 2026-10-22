import { replacePinned } from "./vendor-source-patch.mjs";

/** 复用原身份、签名与刷新锁；签到不是聊天请求，不能只补两个 header。来源 plugins 532e738/4d73d22。 */
export function patchMiniMaxCheckin(source) {
  source = replacePinned(
    source,
    "{ access, userID, body, now = Date.now()",
    "{ access, userID, body, query, now = Date.now()",
  );
  source = replacePinned(source, 'version_code: "22201",', 'version_code: "22201", ...query,');
  source = replacePinned(
    source,
    "class AccountRefused extends Error {}",
    "class AccountRefused extends Error { constructor(message, status) { super(message); this.status = status } }",
  );
  source = replacePinned(
    source,
    "throw new AccountRefused(`${what}: the sign-in was refused (HTTP ${res.status})`)",
    "{ await res.body?.cancel().catch(() => {}); throw new AccountRefused(`${what}: the sign-in was refused (HTTP ${res.status})`, res.status) }",
  );
  source = replacePinned(
    source,
    "env = obj(JSON.parse(await res.text()))",
    "env = obj(JSON.parse(await accountText(res)))",
  );
  source = replacePinned(
    source,
    "if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`)",
    "if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new Error(`${what}: HTTP ${res.status}`) }",
  );
  source = replacePinned(
    source,
    "// ---- requests",
    String.raw`// 原公共签到限制 1 MiB；切换原生账号 API 后仍须有界读取，不能先 text() 再判断。
async function accountText(res) {
  if (!res.body) return ""
  const reader = res.body.getReader(), decoder = new TextDecoder()
  let bytes = 0, text = ""
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) return text + decoder.decode()
      bytes += part.value.byteLength
      if (bytes > 1024 * 1024) throw new Error("MiniMax account response too large")
      text += decoder.decode(part.value, { stream: true })
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

// 签到必须以真实账号签完整 URL；身份不可读时不向领取接口发送 user_id=0。
async function checkinOf(site, access, userID) {
  if (!String(userID ?? "").trim()) userID = (await identity(site, access)).realUserID
  const ask = (path, body) => accountCall(site, "/minimax-cloud/api/v1/signin/" + path, {
    access, userID, body, query: { device_platform: "web", is_desktop: "1", desktop_version: "0.6.12" },
  }, "check-in")
  const panel = await ask("status")
  const days = panel?.data?.days
  if (!Array.isArray(days)) return { outcome: "failed", error: "request_failed" }
  const todays = days.filter(d => d?.is_today === true)
  if (!todays.length) return { outcome: "inactive" }
  if (todays.length !== 1) return { outcome: "failed", error: "request_failed" }
  const today = todays[0]
  const number = v => {
    const n = typeof v === "string" && /^\d+(?:\.\d+)?$/.test(v) ? Number(v) : v
    return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined
  }
  const reward = (points, day) => ({ ...(number(points) === undefined ? {} : { credit: number(points) }),
    ...(Number.isSafeInteger(number(day)) ? { streak: number(day) } : {}) })
  if (today.status === 3) return { outcome: "done", ...reward(today.points, today.day_no) }
  if (today.status === 4) return { outcome: "ineligible" }
  if (today.status !== 2) return { outcome: "inactive" }
  const claim = (await ask("claim", {}))?.data
  if (![1, 2].includes(claim?.claim_result)) return { outcome: "failed", error: "request_failed" }
  return { outcome: claim.claim_result === 1 ? "claimed" : "done", ...reward(claim.points ?? today.points, claim.day_no ?? today.day_no) }
}

// ---- requests`,
  );
  return replacePinned(
    source,
    "        async usage(getAuth) {",
    String.raw`        async checkin(getAuth) {
          const failed = e => ({ outcome: "failed", error: e instanceof SignInExpired ? "sign_in_required" : "request_failed",
            ...(e instanceof SignInExpired ? { signIn: "expired" } : {}) })
          let a
          try {
            ;({ a } = await fresh(getAuth))
            return await checkinOf(site, a.access, a.realUserID)
          } catch (e) {
            if (!(e instanceof AccountRefused && e.status === 401) || !a) return failed(e)
            // 仅确定的 401 走原刷新许可；重读身份后只再询问一次，403 不重发。
            try {
              ;({ a } = await fresh(getAuth, a.access))
              return { ...(await checkinOf(site, a.access, undefined)), signIn: "renewed" }
            } catch (next) { return failed(next) }
          }
        },
        async usage(getAuth) {`,
  );
}
