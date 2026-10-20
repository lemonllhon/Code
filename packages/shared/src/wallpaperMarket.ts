import { z } from "zod";

export const WALLPAPER_MARKET_CATEGORIES = ["all", "general", "anime", "people"] as const;
/** Wallhaven 官方搜索色卡（https://wallhaven.cc/help/api），参数使用无 # 的单色色值。 */
export const WALLPAPER_MARKET_COLORS = [
  "660000",
  "990000",
  "cc0000",
  "cc3333",
  "ea4c88",
  "993399",
  "663399",
  "333399",
  "0066cc",
  "0099cc",
  "66cccc",
  "77cc33",
  "669900",
  "336600",
  "666600",
  "999900",
  "cccc33",
  "ffff00",
  "ffcc33",
  "ff9900",
  "ff6600",
  "cc6633",
  "996633",
  "663300",
  "000000",
  "999999",
  "cccccc",
  "ffffff",
  "424153",
] as const;
export type WallpaperMarketColor = (typeof WALLPAPER_MARKET_COLORS)[number];
export const wallpaperMarketSearchSchema = z
  .object({
    query: z.string().trim().max(200).default(""),
    category: z.enum(WALLPAPER_MARKET_CATEGORIES).default("all"),
    page: z.number().int().min(1).max(100_000).default(1),
    color: z.enum(WALLPAPER_MARKET_COLORS).optional(),
  })
  .strict();

export const wallpaperMarketUrlSchema = z
  .string()
  .url()
  .refine((raw) => {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      (url.hostname === "wallhaven.cc" || url.hostname.endsWith(".wallhaven.cc"))
    );
  }, "Expected an HTTPS Wallhaven URL");

export const wallpaperMarketImageRequestSchema = z
  .object({
    url: wallpaperMarketUrlSchema,
    thumbnail: z.boolean().default(false),
  })
  .strict();

export const wallpaperMarketItemSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+$/),
  thumbUrl: wallpaperMarketUrlSchema,
  fullUrl: wallpaperMarketUrlSchema,
  sourceUrl: wallpaperMarketUrlSchema,
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  fileSize: z.number().int().nonnegative(),
});
export const wallpaperMarketPageSchema = z.object({
  items: z.array(wallpaperMarketItemSchema).max(100),
  page: z.number().int().positive(),
  lastPage: z.number().int().positive(),
});
export const wallpaperMarketImageSchema = z.object({
  mime: z.enum(["image/jpeg", "image/png", "image/webp", "image/avif"]),
  bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength > 0),
});
export type WallpaperMarketSearch = z.input<typeof wallpaperMarketSearchSchema>;
export type WallpaperMarketItem = z.infer<typeof wallpaperMarketItemSchema>;
export type WallpaperMarketPage = z.infer<typeof wallpaperMarketPageSchema>;
export type WallpaperMarketImageRequest = z.input<typeof wallpaperMarketImageRequestSchema>;
export type WallpaperMarketImage = z.infer<typeof wallpaperMarketImageSchema>;
