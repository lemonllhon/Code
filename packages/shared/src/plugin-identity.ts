/** Computer Use 已独立品牌化；历史市场归属与缓存路径继续保留。 */
export const LCODE_CUA_OFFICIAL_PLUGIN_ID = "computer-use@lcode-plugins-official";
export const LCODE_CUA_LEGACY_PLUGIN_IDS = [
  "computer-use@zcode-plugins-official",
  "zcode-cua@zcode-plugins-official",
] as const;

export function canonicalizeLCodePluginId(pluginId: string): string {
  return (LCODE_CUA_LEGACY_PLUGIN_IDS as readonly string[]).includes(pluginId)
    ? LCODE_CUA_OFFICIAL_PLUGIN_ID
    : pluginId;
}

/** 从新到旧排列，显式新键（包含 false）优先。第三方同名插件不参与迁移。 */
export function lcodePluginIdAliases(pluginId: string): readonly string[] {
  return canonicalizeLCodePluginId(pluginId) === LCODE_CUA_OFFICIAL_PLUGIN_ID
    ? [LCODE_CUA_OFFICIAL_PLUGIN_ID, ...LCODE_CUA_LEGACY_PLUGIN_IDS]
    : [pluginId];
}

/** 复用原安装记录、市场归属和 data 目录；品牌迁移不复制或清空数据。 */
export function resolveLCodePluginStorageId(pluginId: string): string {
  return canonicalizeLCodePluginId(pluginId) === LCODE_CUA_OFFICIAL_PLUGIN_ID
    ? LCODE_CUA_LEGACY_PLUGIN_IDS[0]
    : pluginId;
}

export function canonicalizeLCodePluginConfigRecord<T>(
  record: Record<string, T>,
): Record<string, T> {
  const result = { ...record };
  const aliases = lcodePluginIdAliases(LCODE_CUA_OFFICIAL_PLUGIN_ID);
  for (const id of aliases) delete result[id];
  const key = aliases.find((id) => Object.hasOwn(record, id));
  if (key !== undefined) result[LCODE_CUA_OFFICIAL_PLUGIN_ID] = record[key]!;
  return result;
}
