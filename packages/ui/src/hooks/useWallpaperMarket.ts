import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  wallpaperMarketPageSchema,
  wallpaperMarketImageSchema,
  type WallpaperMarketSearch,
  type WallpaperMarketItem,
} from "@lcode/shared";
import { useWallpaperStore } from "@/store/wallpaperStore.js";
import { useOptionalPlatform } from "./usePlatform.js";
import { useLCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { getRecommendedWallpaperColor } from "@/lib/wallpaperMarketColors.js";

function subscribeSystemTheme(changed: () => void) {
  const media = matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", changed);
  return () => media.removeEventListener("change", changed);
}
const systemDarkSnapshot = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

export function useWallpaperMarketThemeColor() {
  const theme = useLCodeStoreWithDefault((state) => state.theme, "system");
  const systemDark = useSyncExternalStore(subscribeSystemTheme, systemDarkSnapshot, () => false);
  return getRecommendedWallpaperColor(theme, systemDark);
}

export function useWallpaperMarket() {
  const platform = useOptionalPlatform();
  const importImage = useWallpaperStore((state) => state.importImage);
  const search = useCallback(
    async (request: WallpaperMarketSearch) => {
      if (!platform?.searchWallpaperMarket) throw new Error("Wallpaper market unavailable");
      return wallpaperMarketPageSchema.parse(await platform.searchWallpaperMarket(request));
    },
    [platform],
  );
  const apply = useCallback(
    (item: WallpaperMarketItem) =>
      importImage(async () => {
        if (!platform?.loadWallpaperMarketImage) throw new Error("Wallpaper market unavailable");
        const image = wallpaperMarketImageSchema.parse(
          await platform.loadWallpaperMarketImage({ url: item.fullUrl }),
        );
        return new Blob([new Uint8Array(image.bytes)], { type: image.mime });
      }, item.id),
    [platform, importImage],
  );
  return {
    supported: Boolean(platform?.searchWallpaperMarket && platform?.loadWallpaperMarketImage),
    search,
    apply,
  };
}

/** 每张可见卡片持有自己的缩略图 URL；关闭或翻页后不发布晚到结果，并释放 Blob URL。 */
export function useWallpaperMarketThumbnail(url: string) {
  const platform = useOptionalPlatform();
  const [thumbnail, setThumbnail] = useState<string>();
  useEffect(() => {
    if (!platform?.loadWallpaperMarketImage) return;
    let disposed = false;
    let objectUrl: string | undefined;
    void platform
      .loadWallpaperMarketImage({ url, thumbnail: true })
      .then((result) => {
        if (disposed) return;
        const image = wallpaperMarketImageSchema.parse(result);
        objectUrl = URL.createObjectURL(
          new Blob([new Uint8Array(image.bytes)], { type: image.mime }),
        );
        setThumbnail(objectUrl);
      })
      .catch(() => {
        if (!disposed) setThumbnail(undefined);
      });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [platform, url]);
  return thumbnail;
}
