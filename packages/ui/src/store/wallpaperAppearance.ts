export const WALLPAPER_FILL_MODES = ["cover", "contain", "center", "tile"] as const;
export interface WallpaperAppearance {
  fill: (typeof WALLPAPER_FILL_MODES)[number];
  maskOpacity: number;
  blur: number;
  panelOpacity: number;
}
export const DEFAULT_WALLPAPER_APPEARANCE: WallpaperAppearance = {
  fill: "cover",
  maskOpacity: 0.8,
  blur: 0,
  panelOpacity: 0,
};
function inRange(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
}
export function normalizeWallpaperAppearance(value: unknown): WallpaperAppearance {
  const input = (value && typeof value === "object" ? value : {}) as Partial<WallpaperAppearance>;
  return {
    fill: WALLPAPER_FILL_MODES.includes(input.fill!) ? input.fill! : "cover",
    maskOpacity: inRange(input.maskOpacity, 0.99) ? input.maskOpacity : 0.8,
    blur: inRange(input.blur, 24) ? input.blur : 0,
    panelOpacity: inRange(input.panelOpacity, 1) ? input.panelOpacity : 0,
  };
}
export function isWallpaperAppearance(value: WallpaperAppearance): boolean {
  return (
    WALLPAPER_FILL_MODES.includes(value.fill) &&
    inRange(value.maskOpacity, 0.99) &&
    inRange(value.blur, 24) &&
    inRange(value.panelOpacity, 1)
  );
}
