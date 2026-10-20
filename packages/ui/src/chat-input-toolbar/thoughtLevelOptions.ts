import type { LCodeConfigOption, LCodeProvider } from "@lcode/shared";
import type { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { getConfigOptionEntryLabel } from "@/chat-input-toolbar/display.js";
import { thoughtLevelLabelId } from "@/chat-input-toolbar/thoughtLevelLabels.js";
export { thoughtLevelLabelId } from "@/chat-input-toolbar/thoughtLevelLabels.js";
export { isNoThoughtLevel } from "./thoughtLevelValues.js";

type ThoughtLevelEntry = NonNullable<LCodeConfigOption["options"]>[number];

function normalizeThoughtLevelText(value: string): string {
  return value.trim().toLowerCase();
}

export function getNextThoughtLevelValue(
  option: Pick<LCodeConfigOption, "type" | "currentValue" | "options">,
): string | null {
  if (option.type !== "select" || !option.options || option.options.length < 2) {
    return null;
  }

  // 配置已声明档位顺序；名称别名只用于展示，不能改变菜单或快捷键顺序。
  const entries = option.options;
  const currentValue = String(option.currentValue);
  const currentIndex = entries.findIndex((candidate) => candidate.value === currentValue);
  const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % entries.length;

  return entries[nextIndex]?.value ?? null;
}

/** 未知词条原样显示供应商档位名称，其他入口复用同一张本地化表。 */
export function getThoughtLevelLabel(
  intl: ReturnType<typeof useLCodeIntl>["intl"],
  provider: LCodeProvider | undefined,
  option: LCodeConfigOption,
  entry: ThoughtLevelEntry,
): string {
  const value = normalizeThoughtLevelText(entry.value);
  const labelId = thoughtLevelLabelId(value);
  if (labelId) {
    return intl.formatMessage({ id: labelId });
  }

  return getConfigOptionEntryLabel(intl, provider, option, entry);
}
