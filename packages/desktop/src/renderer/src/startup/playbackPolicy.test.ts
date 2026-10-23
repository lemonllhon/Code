import assert from "node:assert/strict";
import { test } from "node:test";
import { getCanvasPlaybackBudget, selectStartupVideoFile } from "./playbackPolicy.js";

const desktop = { width: 1200, height: 800, pixelRatio: 1, cores: 16 };
test("普通窗口只解码轻量版，高分辨率保留母版，受限设备的大屏也使用轻量版", () => {
  assert.equal(selectStartupVideoFile(desktop), "baili-lite.mp4");
  assert.equal(selectStartupVideoFile({ ...desktop, width: 3840, height: 2160 }), "baili.mp4");
  assert.equal(selectStartupVideoFile({ ...desktop, pixelRatio: 2 }), "baili.mp4");
  assert.equal(selectStartupVideoFile({ ...desktop, pixelRatio: 2, cores: 4 }), "baili-lite.mp4");
  assert.equal(
    selectStartupVideoFile({ ...desktop, pixelRatio: 2, memoryGiB: 4 }),
    "baili-lite.mp4",
  );
  assert.equal(selectStartupVideoFile({ ...desktop, width: 1920, height: 1080 }), "baili-lite.mp4");
  assert.equal(selectStartupVideoFile({ ...desktop, cores: undefined }), "baili-lite.mp4");
  assert.equal(
    selectStartupVideoFile({ ...desktop, width: 390, height: 844, pixelRatio: 2 }),
    "baili-lite.mp4",
  );
});
test("Canvas 总像素预算覆盖高 DPR 与竖屏，受限设备减少像素与绘制频率", () => {
  for (const dimensions of [
    { width: 3840, height: 2160 },
    { width: 900, height: 3200 },
  ]) {
    for (const cores of [4, 16]) {
      const result = getCanvasPlaybackBudget({ ...desktop, ...dimensions, pixelRatio: 2, cores });
      assert.ok(result.width * result.height <= (cores === 4 ? 1280 * 720 : 1920 * 1080));
      assert.equal(result.frameIntervalMs, cores === 4 ? 1000 / 30 : 1000 / 60);
      assert.ok(result.width > 0 && result.height > 0);
    }
  }
});
