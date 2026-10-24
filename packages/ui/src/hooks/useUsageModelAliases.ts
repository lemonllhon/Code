import { useSettings } from "./useSettingService.js";
import type { UsageModelAliases } from "@lcode/shared";
const EMPTY: UsageModelAliases = {};

/** Settings 服务实例隔离快照，切 Host 时不会读取上一 Host 的别名。 */
export function useUsageModelAliases() {
  const { settings } = useSettings();
  return settings?.usageModelAliases ?? EMPTY;
}
