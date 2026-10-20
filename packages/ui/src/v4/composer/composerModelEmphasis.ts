import type { ModelSelection } from "@lcode/shared";
import type { ModelSelectionView } from "@lcode/services";
import { isNoThoughtLevel } from "../../chat-input-toolbar/thoughtLevelValues.js";

/** 只读当前草稿与同目标目录；不补值、不追踪运行中请求、不写入另一份状态。 */
export function resolveComposerModelEmphasis(
  selection: ModelSelection | null | undefined,
  view: ModelSelectionView | null,
): number {
  if (!selection || !view) return 0;
  const provider = view.providers.find((entry) => entry.providerId === selection.providerId);
  if (!provider) return 0;
  const model = provider.models.find((entry) => entry.modelId === selection.modelId);
  if (!model || model.config.enabled === false) return 0;

  const levels = model.config.optionSpecs.reasoningLevel?.values ?? [];
  const thinkingLevels = levels.filter((value) => !isNoThoughtLevel({ value }));
  const current = selection.options?.reasoningLevel;
  // 旧版旗舰/最高档准入使 default 和普通模型无效果；所有模型统一按目录索引增强。
  const thinkingIndex = thinkingLevels.indexOf(current ?? "");
  if (thinkingIndex < 0 || thinkingLevels.length < 2) return 0.28;
  return 0.28 + (0.72 * thinkingIndex) / (thinkingLevels.length - 1);
}
