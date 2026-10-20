import type { ModelSelection } from "@lcode/shared";
import type { ModelSelectionView } from "@lcode/services";
import { isNoThoughtLevel } from "../../chat-input-toolbar/thoughtLevelValues.js";

interface FlagshipCandidate {
  family: string;
  version: number[];
  tier: number;
}

// 仅用于视觉强调；目录顺序、价格和显示名称都不能证明模型能力。
const FLAGSHIP_SERIES = [
  { family: "claude", pattern: /^claude-(?:fable|opus)-(\d+(?:[.-]\d{1,2}(?!\d))*)/ },
  { family: "gpt", pattern: /^gpt-(\d+(?:\.\d+)*)(?:-(astra|pro|sol|codex))?/ },
  { family: "gemini", pattern: /^gemini-(\d+(?:\.\d+)*)-pro/ },
  { family: "glm", pattern: /^glm-(\d+(?:\.\d+)*)/ },
  { family: "kimi", pattern: /^kimi-k(\d+(?:\.\d+)*)(?:-code)?/ },
  { family: "minimax", pattern: /^minimax-m(\d+(?:\.\d+)*)/ },
  { family: "deepseek-v", pattern: /^deepseek-v(\d+(?:\.\d+)*)(?:-pro)?/ },
  { family: "deepseek-r", pattern: /^deepseek-r(\d+(?:\.\d+)*)/ },
  { family: "qwen", pattern: /^qwen(\d+(?:\.\d+)*)-max/ },
  { family: "mimo", pattern: /^mimo-v(\d+(?:\.\d+)*)-pro/ },
  { family: "grok", pattern: /^grok-(\d+(?:\.\d+)*)/ },
];
const ROUTE_SUFFIX = /^(?:-(?:preview|latest|thinking|highspeed|\d{4,8}))*$/;

function flagshipCandidate(modelId: string): FlagshipCandidate | null {
  const id = modelId.split("/").at(-1)?.toLowerCase() ?? "";
  for (const { family, pattern } of FLAGSHIP_SERIES) {
    const match = pattern.exec(id);
    if (!match || !ROUTE_SUFFIX.test(id.slice(match[0].length))) continue;
    return {
      family,
      version: match[1]!.split(/[.-]/).map(Number),
      tier: id.startsWith("claude-fable-") || match[2] === "astra" ? 2 : match[2] === "pro" ? 1 : 0,
    };
  }
  return null;
}

function compareCandidates(left: FlagshipCandidate, right: FlagshipCandidate): number {
  for (let index = 0; index < Math.max(left.version.length, right.version.length); index++) {
    const difference = (left.version[index] ?? 0) - (right.version[index] ?? 0);
    if (difference) return difference;
  }
  return left.tier - right.tier;
}

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
  if (
    current &&
    thinkingLevels.length > 1 &&
    current === levels.at(-1) &&
    !isNoThoughtLevel({ value: current })
  ) {
    return 1;
  }

  const candidate = flagshipCandidate(selection.modelId);
  const isFlagship = Boolean(
    candidate &&
    !provider.models.some((other) => {
      if (other.config.enabled === false) return false;
      const competitor = flagshipCandidate(other.modelId);
      return (
        competitor?.family === candidate.family && compareCandidates(competitor, candidate) > 0
      );
    }),
  );
  if (!isFlagship) return 0;
  // 原先只有开关，旗舰降低思考档位仍呈现同一效果；用目录进度统一驱动速度和底光。
  const thinkingIndex = thinkingLevels.indexOf(current ?? "");
  return 0.28 + (thinkingIndex < 0 ? 0 : (0.72 * (thinkingIndex + 1)) / thinkingLevels.length);
}
