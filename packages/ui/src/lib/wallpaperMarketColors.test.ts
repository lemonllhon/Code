import assert from "node:assert/strict";
import { test } from "node:test";
import { getRecommendedWallpaperColor } from "./wallpaperMarketColors.js";
import type { Theme } from "../themeConfig.js";

test("按七个界面主题的视觉色系推荐 Wallhaven 颜色，兼容系统和旧主题", () => {
  const expected: [Theme, string][] = [
    ["zai-dark", "424153"],
    ["zai-light", "999999"],
    ["sepia-light", "ffcc33"],
    ["midnight-blue", "0099cc"],
    ["forest-dark", "336600"],
    ["cinnabar", "cc3333"],
    ["inkpurple", "663399"],
    ["dark", "424153"],
    ["light", "999999"],
  ];
  for (const [theme, color] of expected)
    assert.equal(getRecommendedWallpaperColor(theme, false).color, color);
  assert.equal(getRecommendedWallpaperColor("system", true).color, "424153");
  assert.equal(getRecommendedWallpaperColor("system", false).color, "999999");
});
