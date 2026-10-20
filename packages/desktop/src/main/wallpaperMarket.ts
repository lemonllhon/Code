import { z } from "zod";
import {
  wallpaperMarketSearchSchema,
  wallpaperMarketImageRequestSchema,
  wallpaperMarketUrlSchema,
  wallpaperMarketItemSchema,
  wallpaperMarketPageSchema,
  wallpaperMarketImageSchema,
} from "@lcode/shared";

const upstreamSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string(),
        path: z.string(),
        thumbs: z.object({ small: z.string() }),
        dimension_x: z.number().int().nonnegative().default(0),
        dimension_y: z.number().int().nonnegative().default(0),
        file_size: z.number().int().nonnegative().default(0),
      }),
    )
    .max(100),
  meta: z.object({
    current_page: z.number().int().positive(),
    last_page: z.number().int().positive(),
  }),
});

/** Main 只执行有边界的网络 IO；选择、图片和持久化仍由 renderer 的 wallpaperStore 持有。 */
export function createWallpaperMarket(
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
) {
  async function read(raw: string, cap: number | undefined, image: boolean) {
    const signal = AbortSignal.timeout(image ? 45_000 : 20_000);
    let url = wallpaperMarketUrlSchema.parse(raw);
    for (let hop = 0; hop < 5; hop++) {
      const response = await fetcher(url, { redirect: "manual", credentials: "omit", signal });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw new Error("Missing market redirect");
        // 重定向也校验同一允许域，不能让外部资源借下载通道进入本机。
        url = wallpaperMarketUrlSchema.parse(new URL(location, url).href);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Wallpaper market HTTP ${response.status}`);
      }
      const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
      const allowed = image
        ? ["image/jpeg", "image/png", "image/webp", "image/avif"]
        : ["application/json"];
      if (
        !mime ||
        !allowed.includes(mime) ||
        (cap !== undefined && Number(response.headers.get("content-length")) > cap)
      ) {
        await response.body?.cancel();
        throw new Error("Invalid wallpaper response format or size");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Empty wallpaper response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (cap !== undefined && size > cap)
            throw new Error("Wallpaper response exceeds size limit");
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { mime, bytes };
    }
    throw new Error("Too many wallpaper redirects");
  }
  return {
    async search(request: unknown) {
      const { query, category, page, color } = wallpaperMarketSearchSchema.parse(request);
      const url = new URL("https://wallhaven.cc/api/v1/search");
      url.search = new URLSearchParams({
        q: query,
        categories: { all: "111", general: "100", anime: "010", people: "001" }[category],
        purity: "100",
        page: String(page),
        sorting: query ? "relevance" : "toplist",
        topRange: "1M",
      }).toString();
      if (color) url.searchParams.set("colors", color);
      const { bytes } = await read(url.href, 2 * 1024 * 1024, false);
      const payload = upstreamSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
      const items = payload.data.flatMap((entry) => {
        const item = wallpaperMarketItemSchema.safeParse({
          id: entry.id,
          fullUrl: entry.path,
          thumbUrl: entry.thumbs.small,
          sourceUrl: `https://wallhaven.cc/w/${entry.id}`,
          width: entry.dimension_x,
          height: entry.dimension_y,
          fileSize: entry.file_size,
        });
        return item.success ? [item.data] : [];
      });
      return wallpaperMarketPageSchema.parse({
        items,
        page: payload.meta.current_page,
        lastPage: payload.meta.last_page,
      });
    },
    async image(request: unknown) {
      const { url, thumbnail } = wallpaperMarketImageRequestSchema.parse(request);
      return wallpaperMarketImageSchema.parse(
        await read(url, thumbnail ? 2 * 1024 * 1024 : undefined, true),
      );
    },
  };
}
