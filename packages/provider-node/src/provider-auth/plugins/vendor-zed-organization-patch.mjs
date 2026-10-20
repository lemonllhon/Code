import { replacePinned, replacePinnedRegion } from "./vendor-source-patch.mjs";

/** 移植 plugins 5b68df0 的组织选择；持久化仍等待原 Host CAS，不移植后台写回/推理重放。 */
export function patchZedOrganization(source) {
  source = replacePinnedRegion(
    source,
    "function orgOf(me) {",
    "function modelsOff(me, org) {",
    `function orgOf(me, saved = "") {
  const orgs = (me.organizations ?? []).filter((o) => o?.id)
  const usable = (o) => !!o && typeof me.plans_by_organization?.[o.id] === "string" && !!me.plans_by_organization[o.id] && me.plans_by_organization[o.id] !== "zed_free" && !modelsOff(me, o.id)
  const keep = orgs.find((o) => o.id === saved)
  const def = orgs.find((o) => o.id === me.default_organization_id)
  const pick = [keep, def].find(usable) ?? orgs.find((o) => o.is_personal && usable(o)) ?? orgs.find(usable) ?? keep ?? def ?? orgs[0]
  return pick?.id || saved || me.default_organization_id || ""
}
function planOf(me, org) {
  const known = org && (me.organizations ?? []).some((o) => o?.id === org) && me.plans_by_organization && typeof me.plans_by_organization === "object"
  return known ? me.plans_by_organization[org] || "" : me.plan?.plan_v3 || ""
}

`,
  );
  source = replacePinned(
    source,
    'const key = s.userId + " " + s.access',
    'const key = s.userId + " " + s.org + " " + s.access',
  );
  source = replacePinned(
    source,
    "const plan = planOf(me, s.org || orgOf(me))",
    "const org = orgOf(me, s.org)\n  const plan = planOf(me, org)",
  );
  source = replacePinned(
    source,
    "if (plan !== s.plan && save)",
    "if (save && (plan !== s.plan || org !== s.org))",
  );
  source = replacePinned(
    source,
    "refresh: JSON.stringify({ ...r, plan, planName: out.plan })",
    "refresh: JSON.stringify({ ...r, org, plan, planName: out.plan })",
  );
  // 使用当前 operation 的凭据通道，CAS 成功前不查询新组织，取消/退休后不写入。
  source = replacePinned(
    source,
    "export async function ZedAuthPlugin({ client } = {}) {",
    `async function selectOrganization(auth, save) {
  const s = stateOf(auth)
  if (!s?.org) return s
  const me = parse(await cloud("GET", "/client/users/me", s))
  if (!me || typeof me !== "object" || !Array.isArray(me.organizations)) throw new Error("Zed: an unreadable organization list")
  const org = orgOf(me, s.org), plan = planOf(me, org)
  if (save && (org !== s.org || plan !== s.plan)) {
    const r = parse(auth.refresh ?? "") ?? {}
    await save({ ...auth, refresh: JSON.stringify({ ...r, org, plan, planName: planName(plan) }) })
  }
  return { ...s, org, plan }
}
export async function ZedAuthPlugin({ client } = {}) {
  const save = client?.auth?.set ? (body) => client.auth.set({ path: { id: PROVIDER }, body }) : null`,
  );
  source = replacePinned(
    source,
    "if (!l || Date.now() - l.at > MODELS_TTL) {",
    "if (!l || l.org !== s.org || Date.now() - l.at > MODELS_TTL) {\n          Object.assign(s, await selectOrganization(auth, save))",
  );
  source = replacePinned(
    source,
    "l = { at: Date.now(), models: await fetchModels(s) }",
    "l = { at: Date.now(), org: s.org, models: await fetchModels(s) }",
  );
  source = replacePinned(
    source,
    "lists.set(uid, { at: Date.now(), models: await fetchModels(s) })",
    "lists.set(uid, { at: Date.now(), org: s.org, models: await fetchModels(s) })",
  );
  // 原 usage 的 catch 会吞 CAS 失败；本地凭据写入失败必须让当前操作失败。
  return replacePinned(
    source,
    "await save({ ...auth, refresh: JSON.stringify({ ...r, org, plan, planName: out.plan }) }).catch(() => {})",
    "await save({ ...auth, refresh: JSON.stringify({ ...r, org, plan, planName: out.plan }) })",
  );
}
