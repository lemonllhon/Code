import assert from "node:assert/strict";
import { test } from "node:test";
import { createWallpaperMarket } from "./wallpaperMarket.js";

const item = {
  id: "abc123",
  path: "https://w.wallhaven.cc/full/ab/wallhaven-abc123.jpg",
  thumbs: { small: "https://th.wallhaven.cc/small/ab/abc123.jpg" },
  dimension_x: 1920,
  dimension_y: 1080,
  file_size: 1234,
};
test("市场只搜索 SFW，校验输入与列表 URL，保留服务端实际页码", async () => {
  let requested = "";
  const api = createWallpaperMarket(async (url) => {
    requested = String(url);
    return Response.json({
      data: [item, { ...item, path: "https://evil.example/a.jpg" }],
      meta: { current_page: 2, last_page: 5 },
    });
  });
  const result = await api.search({
    query: " sky ",
    category: "general",
    page: 2,
    color: "0099cc",
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.page, 2);
  assert.equal(result.items[0]?.sourceUrl, "https://wallhaven.cc/w/abc123");
  const url = new URL(requested);
  assert.equal(url.searchParams.get("purity"), "100");
  assert.equal(url.searchParams.get("categories"), "100");
  assert.equal(url.searchParams.get("q"), "sky");
  assert.equal(url.searchParams.get("colors"), "0099cc");
  await api.search({});
  assert.equal(new URL(requested).searchParams.has("colors"), false);
  await assert.rejects(api.search({ color: "#0099cc" }));
  await assert.rejects(api.search({ color: "123456" }));
  await assert.rejects(api.search({ category: "nsfw" }));
  await assert.rejects(api.search({ query: "a".repeat(201) }));
});

test("图片请求禁止外部 URL、凭据与外部重定向，保留格式与缩略图字节限制", async () => {
  let response = new Response(null, {
    status: 302,
    headers: { location: "https://evil.example/image.jpg" },
  });
  let calls = 0;
  const api = createWallpaperMarket(async () => {
    calls++;
    return response;
  });
  for (const url of [
    "http://w.wallhaven.cc/a.jpg",
    "https://wallhaven.cc.evil/a.jpg",
    "https://user@wallhaven.cc/a.jpg",
    "https://wallhaven.cc:444/a.jpg",
  ]) {
    await assert.rejects(api.image({ url, thumbnail: true }));
  }
  assert.equal(calls, 0);
  await assert.rejects(api.image({ url: item.path, thumbnail: true }));
  assert.equal(calls, 1);
  response = new Response("html", { headers: { "content-type": "text/html" } });
  await assert.rejects(api.image({ url: item.path }));
  response = new Response(new Uint8Array(2 * 1024 * 1024 + 1), {
    headers: { "content-type": "image/png" },
  });
  await assert.rejects(api.image({ url: item.path, thumbnail: true }));
  response = new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } });
  assert.deepEqual(await api.image({ url: item.path }), {
    mime: "image/jpeg",
    bytes: new Uint8Array([1, 2, 3]),
  });
});

test("原图下载不再限制文件字节数，兼容声明大小与分块传输", async () => {
  const bytes = new Uint8Array(11 * 1024 * 1024);
  for (const declaredLength of [undefined, String(bytes.byteLength)]) {
    const headers = new Headers({ "content-type": "image/png" });
    if (declaredLength) headers.set("content-length", declaredLength);
    const api = createWallpaperMarket(async () => new Response(bytes, { headers }));
    const image = await api.image({ url: item.path });
    assert.equal(image.bytes.byteLength, bytes.byteLength);
  }
});
