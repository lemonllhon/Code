import assert from "node:assert/strict";
import { test } from "node:test";
import { createWallpaperStore, type WallpaperRecord } from "./wallpaperStore.js";
import { WALLPAPER_SOURCES, decodeWallpaperImage } from "./wallpaperStorage.js";
import {
  DEFAULT_WALLPAPER_APPEARANCE,
  normalizeWallpaperAppearance,
} from "./wallpaperAppearance.js";

test("旧显示参数使用兼容默认值，非法数据归一；参数和图片沿同一记录保存并恢复", async () => {
  assert.deepEqual(normalizeWallpaperAppearance(undefined), DEFAULT_WALLPAPER_APPEARANCE);
  assert.deepEqual(
    normalizeWallpaperAppearance({ fill: "bad", blur: NaN, maskOpacity: -1, panelOpacity: 2 }),
    DEFAULT_WALLPAPER_APPEARANCE,
  );
  let saved: WallpaperRecord | undefined;
  const storage = {
    read: async () => saved,
    write: async (record: WallpaperRecord) => {
      saved = record;
    },
  };
  const store = createWallpaperStore(storage, async () => {});
  const appearance = { fill: "tile" as const, blur: 12, maskOpacity: 0.4, panelOpacity: 0.3 };
  assert.equal(await store.getState().updateAppearance(appearance), true);
  assert.equal(await store.getState().updateAppearance({ blur: 25 }), false);
  await store.getState().importImage(new Blob(["image"], { type: "image/png" }), "abc123");
  assert.deepEqual(store.getState().record.appearance, appearance);
  assert.equal(store.getState().record.marketId, "abc123");
  const restored = createWallpaperStore(storage);
  await restored.getState().initialize();
  assert.deepEqual(restored.getState().record.appearance, appearance);
  await store.getState().importImage(new Blob(["local"], { type: "image/png" }));
  assert.equal(store.getState().record.marketId, undefined);
  assert.deepEqual(store.getState().record.appearance, appearance);
});

test("市场下载进入串行 admission，晚到下载不覆盖后续关闭；失败保留原图片与参数", async () => {
  let release!: (blob: Blob) => void;
  const download = new Promise<Blob>((resolve) => {
    release = resolve;
  });
  const writes: WallpaperRecord[] = [];
  const store = createWallpaperStore(
    {
      read: async () => undefined,
      write: async (record) => {
        writes.push(record);
      },
    },
    async () => {},
  );
  const applying = store.getState().importImage(() => download, "abc123");
  const adjusting = store.getState().updateAppearance({ blur: 8 });
  const closing = store.getState().select("none");
  release(new Blob(["market"], { type: "image/png" }));
  await Promise.all([applying, adjusting, closing]);
  assert.deepEqual(
    writes.map((record) => record.source),
    ["custom", "custom", "none"],
  );
  assert.equal(store.getState().record.appearance?.blur, 8);
  const before = store.getState().record;
  assert.equal(
    await store.getState().importImage(async () => {
      throw new Error("offline");
    }),
    false,
  );
  assert.equal(store.getState().record, before);
});

test("已删除的壁纸来源回到关闭，保留有效图片并复用原写入路径", async () => {
  assert.deepEqual(WALLPAPER_SOURCES, ["none", "baili", "aemeath", "custom"]);
  const image = new Blob(["image"], { type: "image/png" });
  const writes: WallpaperRecord[] = [];
  const store = createWallpaperStore({
    read: async () => ({ source: "dragon", image }) as unknown as WallpaperRecord,
    write: async (record) => {
      writes.push(record);
    },
  });
  await store.getState().initialize();
  assert.deepEqual(store.getState().record, { source: "none", image });
  assert.equal(writes.length, 0);
  await store.getState().select("custom");
  assert.deepEqual(writes, [{ source: "custom", image }]);
});

test("慢解码按命令顺序保存，不覆盖后来的选择；解码错误保留旧壁纸", async () => {
  let release!: () => void;
  const decoding = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writes: string[] = [];
  const store = createWallpaperStore(
    {
      read: async () => ({ source: "none" }),
      write: async (record) => {
        writes.push(record.source);
      },
    },
    () => decoding,
  );
  const importing = store.getState().importImage(new Blob(["image"], { type: "image/png" }));
  const selecting = store.getState().select("baili");
  assert.equal(store.getState().busy, true);
  release();
  await Promise.all([importing, selecting]);
  assert.deepEqual(writes, ["custom", "baili"]);
  assert.equal(store.getState().record.source, "baili");
  const broken = createWallpaperStore(
    { read: async () => ({ source: "none" }), write: async () => assert.fail() },
    async () => {
      throw new Error("decode");
    },
  );
  assert.equal(
    await broken.getState().importImage(new Blob(["broken"], { type: "image/png" })),
    false,
  );
  assert.equal(broken.getState().record.source, "none");
});

test("壁纸初始化先于写入，串行保存的最后选择胜出", async () => {
  let release!: (value: WallpaperRecord) => void;
  const writes: string[] = [];
  const store = createWallpaperStore({
    read: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    write: async (record) => {
      writes.push(record.source);
    },
  });
  const first = store.getState().select("baili");
  const last = store.getState().select("none");
  release({ source: "none" });
  await Promise.all([first, last]);
  assert.deepEqual(writes, ["baili", "none"]);
  assert.equal(store.getState().record.source, "none");
});

test("保存失败不替换当前壁纸；关闭保留图片以便重选", async () => {
  const image = new Blob(["image"], { type: "image/png" });
  let fail = false;
  const store = createWallpaperStore({
    read: async () => ({ source: "custom", image }),
    write: async () => {
      if (fail) throw new Error("quota");
    },
  });
  await store.getState().initialize();
  fail = true;
  assert.equal(await store.getState().select("baili"), false);
  assert.equal(store.getState().record.source, "custom");
  fail = false;
  await store.getState().select("none");
  assert.equal(store.getState().record.image, image);
  await store.getState().select("custom");
  assert.equal(store.getState().record.source, "custom");
});

test("非法图片、空图片及不存在的自选图片不能保存", async () => {
  let writes = 0;
  const store = createWallpaperStore({
    read: async () => undefined,
    write: async () => {
      writes++;
    },
  });
  assert.equal(await store.getState().select("custom"), false);
  assert.equal(
    await store.getState().importImage(new Blob(["<svg/>"], { type: "image/svg+xml" })),
    false,
  );
  assert.equal(await store.getState().importImage(new Blob([], { type: "image/png" })), false);
  assert.equal(writes, 0);
});

test("大于旧文件上限的壁纸可导入、保存并恢复", async () => {
  const image = new Blob([new Uint8Array(11 * 1024 * 1024)], { type: "image/png" });
  let saved: WallpaperRecord | undefined;
  const storage = {
    read: async () => saved,
    write: async (record: WallpaperRecord) => {
      saved = record;
    },
  };
  const store = createWallpaperStore(storage, async () => {});
  assert.equal(await store.getState().importImage(image, "large123"), true);
  assert.equal(saved?.image, image);
  const restored = createWallpaperStore(storage);
  await restored.getState().initialize();
  assert.equal(restored.getState().record.image?.size, image.size);
  assert.equal(restored.getState().record.marketId, "large123");
});

test("GIF 沿原导入路径解码并保存完整 Blob，重载保留格式和动画字节", async () => {
  const image = new Blob(["GIF89a", new Uint8Array([1, 2, 3, 4])], { type: "image/gif" });
  let saved: WallpaperRecord | undefined;
  let decoded: Blob | undefined;
  const storage = {
    read: async () => saved,
    write: async (record: WallpaperRecord) => {
      saved = record;
    },
  };
  const store = createWallpaperStore(storage, async (blob) => {
    decoded = blob;
  });
  assert.equal(await store.getState().importImage(image), true);
  assert.equal(decoded, image);
  assert.equal(saved?.image, image);
  const restored = createWallpaperStore(storage);
  await restored.getState().initialize();
  assert.equal(restored.getState().record.source, "custom");
  assert.equal(restored.getState().record.image?.type, "image/gif");
  assert.deepEqual(
    await restored.getState().record.image?.arrayBuffer(),
    await image.arrayBuffer(),
  );
});

test("大于旧像素上限的图片可解码，空尺寸仍然拒绝", async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Image");
  let width = 10_000;
  Object.defineProperty(globalThis, "Image", {
    configurable: true,
    value: class {
      src = "";
      naturalWidth = width;
      naturalHeight = 5_000;
      async decode() {}
    },
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "Image", descriptor);
    else Reflect.deleteProperty(globalThis, "Image");
  });
  const image = new Blob(["decoded image"], { type: "image/png" });
  await decodeWallpaperImage(image);
  width = 0;
  await assert.rejects(decodeWallpaperImage(image));
});

test("删除市场图片清除 Blob 和来源并关闭当前图片，重载不恢复且保留显示参数", async () => {
  const appearance = { ...DEFAULT_WALLPAPER_APPEARANCE, blur: 8 };
  let saved: WallpaperRecord = {
    source: "custom",
    image: new Blob(["image"], { type: "image/png" }),
    marketId: "abc123",
    appearance,
  };
  const storage = {
    read: async () => saved,
    write: async (record: WallpaperRecord) => {
      saved = record;
    },
  };
  const store = createWallpaperStore(storage);
  assert.equal(await store.getState().removeImage(), true);
  assert.equal(saved.source, "none");
  assert.equal(saved.image, undefined);
  assert.equal(saved.marketId, undefined);
  assert.deepEqual(saved.appearance, appearance);
  const restored = createWallpaperStore(storage);
  await restored.getState().initialize();
  assert.equal(restored.getState().record.image, undefined);
  assert.equal(await restored.getState().select("custom"), false);
});

test("删除失败保留原图片；下载后的删除按顺序提交且保留内置壁纸选择", async () => {
  let fail = true;
  const image = new Blob(["image"], { type: "image/png" });
  const initial: WallpaperRecord = { source: "custom", image, marketId: "abc123" };
  const store = createWallpaperStore(
    {
      read: async () => initial,
      write: async () => {
        if (fail) throw new Error("quota");
      },
    },
    async () => {},
  );
  assert.equal(await store.getState().removeImage(), false);
  assert.equal(store.getState().record.image, image);
  assert.equal(store.getState().record.marketId, "abc123");
  fail = false;
  let release!: (image: Blob) => void;
  const download = new Promise<Blob>((resolve) => {
    release = resolve;
  });
  const importing = store.getState().importImage(() => download, "next123");
  const selecting = store.getState().select("baili");
  const deleting = store.getState().removeImage();
  release(image);
  await Promise.all([importing, selecting, deleting]);
  assert.equal(store.getState().record.source, "baili");
  assert.equal(store.getState().record.image, undefined);
  assert.equal(store.getState().record.marketId, undefined);
});
