import type { WallpaperMarketColor } from "@lcode/shared";
import { resolveAppliedThemeOption, type Theme } from "../themeConfig.js";

export type WallpaperMarketColorChoice = "theme" | "all" | WallpaperMarketColor;
// 对应主题的视觉色系；主题校验、旧值迁移和系统解析继续由 themeConfig 唯一负责。
const THEME_COLORS: Partial<Record<Theme, WallpaperMarketColor>> = {
  "zai-dark": "424153",
  "zai-light": "999999",
  "sepia-light": "ffcc33",
  "midnight-blue": "0099cc",
  "forest-dark": "336600",
  cinnabar: "cc3333",
  inkpurple: "663399",
};

export function getRecommendedWallpaperColor(theme: Theme, systemDark: boolean) {
  const option = resolveAppliedThemeOption(theme, systemDark);
  return {
    color: THEME_COLORS[option.id] ?? (option.base === "dark" ? "424153" : "999999"),
    themeLabelKey: option.labelKey,
  };
}
