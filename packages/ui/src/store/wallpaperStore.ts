import { create } from "zustand";
import {
  isWallpaperAppearance,
  normalizeWallpaperAppearance,
  type WallpaperAppearance,
} from "./wallpaperAppearance.js";
import {
  isWallpaperImage,
  WALLPAPER_SOURCES,
  wallpaperStorage,
  decodeWallpaperImage,
  type WallpaperRecord,
  type WallpaperSource,
  type WallpaperStorage,
} from "./wallpaperStorage.js";
export type { WallpaperRecord } from "./wallpaperStorage.js";

interface WallpaperState {
  record: WallpaperRecord;
  initialized: boolean;
  busy: boolean;
  failed: boolean;
  initialize(): Promise<void>;
  select(source: WallpaperSource): Promise<boolean>;
  importImage(image: Blob | (() => Promise<Blob>), marketId?: string): Promise<boolean>;
  updateAppearance(patch: Partial<WallpaperAppearance>): Promise<boolean>;
  removeImage(): Promise<boolean>;
}

/** 本机装饰偏好不进入广播设置或 Host；一条串行写入路径持有图片与选择。 */
export function createWallpaperStore(
  storage: WallpaperStorage,
  decode: (image: Blob) => Promise<void> = decodeWallpaperImage,
) {
  let initialization: Promise<void> | undefined;
  let queue = Promise.resolve();
  let pending = 0;
  return create<WallpaperState>((set, get) => {
    const persist = (
      change: (record: WallpaperRecord) => WallpaperRecord | Promise<WallpaperRecord>,
    ) => {
      pending++;
      set({ busy: true, failed: false });
      const initialized = get().initialize();
      const result = queue.then(async () => {
        await initialized;
        try {
          const record = await change(get().record);
          if (
            !WALLPAPER_SOURCES.includes(record.source) ||
            (record.source === "custom" && !record.image) ||
            (record.image && !isWallpaperImage(record.image))
          )
            throw new Error("Invalid wallpaper");
          await storage.write(record);
          set({ record, failed: false });
          return true;
        } catch {
          set({ failed: true });
          return false;
        } finally {
          pending--;
          set({ busy: pending > 0 });
        }
      });
      queue = result.then(() => {});
      return result;
    };
    return {
      record: { source: "none" },
      initialized: false,
      busy: false,
      failed: false,
      initialize() {
        initialization ??= storage
          .read()
          .then((record) => {
            // 移除的来源只投影为关闭，保留有效自选图；后续保存仍经过唯一串行写入路径。
            if (record && !WALLPAPER_SOURCES.includes(record.source))
              record = { ...record, source: "none" };
            if (record?.appearance)
              record = { ...record, appearance: normalizeWallpaperAppearance(record.appearance) };
            if (
              record &&
              WALLPAPER_SOURCES.includes(record.source) &&
              (!record.image || (record.image instanceof Blob && isWallpaperImage(record.image))) &&
              (record.source !== "custom" || record.image)
            )
              set({ record });
          })
          .catch(() => {
            set({ failed: true });
          })
          .finally(() => {
            set({ initialized: true });
          });
        return initialization;
      },
      select: (source) => persist((record) => ({ ...record, source })),
      // 删除仍排在下载/选择之后提交，清除 Blob 与来源；内置壁纸和显示参数保留。
      removeImage: () =>
        persist((record) => ({
          ...record,
          source: record.source === "custom" ? "none" : record.source,
          image: undefined,
          marketId: undefined,
        })),
      updateAppearance: (patch) =>
        persist((record) => {
          const appearance = { ...normalizeWallpaperAppearance(record.appearance), ...patch };
          if (!isWallpaperAppearance(appearance)) throw new Error("Invalid wallpaper appearance");
          return { ...record, appearance };
        }),
      // 图片解码也进入同一 admission：切换/关闭设置后，慢解码不能覆盖更新的选择。
      importImage: (input, marketId) =>
        persist(async (record) => {
          const image = typeof input === "function" ? await input() : input;
          if (!isWallpaperImage(image)) throw new Error("Invalid image");
          await decode(image);
          return {
            ...record,
            source: "custom",
            image,
            ...(marketId ? { marketId } : { marketId: undefined }),
          };
        }),
    };
  });
}

export const useWallpaperStore = createWallpaperStore(wallpaperStorage, decodeWallpaperImage);
