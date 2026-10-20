import { useEffect } from "react";
import { useWallpaperStore } from "@/store/wallpaperStore.js";
import { useOptionalPlatform } from "./usePlatform.js";
import { normalizeWallpaperAppearance } from "@/store/wallpaperAppearance.js";

export function useWallpaper() {
  const state = useWallpaperStore();
  const platform = useOptionalPlatform();
  const supported = Boolean(platform?.getBuiltinWallpaperUrl);
  useEffect(() => {
    if (supported) void state.initialize();
  }, [supported, state.initialize]);
  return {
    ...state,
    appearance: normalizeWallpaperAppearance(state.record.appearance),
    supported,
    builtinUrl: (source: "baili" | "aemeath") => platform?.getBuiltinWallpaperUrl?.(source),
  };
}
