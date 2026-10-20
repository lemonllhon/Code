import type { WallpaperAppearance } from "./wallpaperAppearance.js";

export const WALLPAPER_SOURCES = ["none", "baili", "aemeath", "custom"] as const;
export type WallpaperSource = (typeof WALLPAPER_SOURCES)[number];
export interface WallpaperRecord {
  source: WallpaperSource;
  image?: Blob;
  marketId?: string;
  appearance?: WallpaperAppearance;
}
export interface WallpaperStorage {
  read(): Promise<WallpaperRecord | undefined>;
  write(record: WallpaperRecord): Promise<void>;
}
// 壁纸不设产品级体积/像素上限，仍以格式与浏览器实际解码结果为准。
export function isWallpaperImage(image: Blob): boolean {
  return (
    image.size > 0 &&
    ["image/png", "image/jpeg", "image/webp", "image/avif", "image/gif"].includes(image.type)
  );
}

export async function decodeWallpaperImage(blob: Blob): Promise<void> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("Invalid image dimensions");
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("lcode-local-appearance", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("wallpaper");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Wallpaper storage is busy"));
  });
}

async function transaction(mode: IDBTransactionMode, record?: WallpaperRecord) {
  const db = await database();
  try {
    return await new Promise<WallpaperRecord | undefined>((resolve, reject) => {
      const tx = db.transaction("wallpaper", mode);
      const request =
        mode === "readonly"
          ? tx.objectStore("wallpaper").get("current")
          : tx.objectStore("wallpaper").put(record, "current");
      tx.oncomplete = () => resolve(mode === "readonly" ? request.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("Wallpaper storage aborted"));
    });
  } finally {
    db.close();
  }
}

export const wallpaperStorage: WallpaperStorage = {
  read: () => transaction("readonly"),
  write: async (record) => {
    await transaction("readwrite", record);
  },
};
