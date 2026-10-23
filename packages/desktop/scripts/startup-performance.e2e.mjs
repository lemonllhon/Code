import assert from "node:assert/strict";
import { resolve } from "node:path";

export async function runStartupPerformanceTests({ t, page, navigate, artifacts }) {
  await t.test(
    "ordinary window decodes the lightweight video without changing the timeline",
    { skip: false },
    async () => {
      const dpr = await page.evaluate(() => devicePixelRatio);
      const viewport = { width: Math.floor(1600 / dpr), height: Math.floor(900 / dpr) };
      await page.setViewportSize(viewport);
      await navigate("cinematic");
      await page.waitForFunction(() => document.querySelector("video")?.currentTime > 0.1);
      const media = await page.locator("#loading video").evaluate((video) => ({
        width: video.videoWidth,
        height: video.videoHeight,
        duration: video.duration,
        src: video.currentSrc,
      }));
      assert.deepEqual([media.width, media.height], [1920, 1080]);
      assert.ok(Math.abs(media.duration - 16) < 0.1);
      assert.ok(media.src.endsWith("/baili-lite.mp4"));
      assert.equal(
        await page.locator("#loading video").evaluate((video) => getComputedStyle(video).objectFit),
        "contain",
      );
      const box = await page.locator("#loading video").boundingBox();
      assert.ok(
        Math.abs(box.width - viewport.width) < 1 && Math.abs(box.height - viewport.height) < 1,
      );
      assert.equal(await page.locator("video").count(), 1);
      const fill = await page.locator("#loading video").evaluate(async (video) => {
        const style = getComputedStyle(video);
        const match = style.backgroundImage.match(/url\("?([^")]+)"?\)/);
        const image = new Image();
        image.src = match[1];
        await image.decode();
        return {
          width: image.naturalWidth,
          height: image.naturalHeight,
          source: image.src,
          filter: style.filter,
        };
      });
      assert.deepEqual([fill.width, fill.height], [480, 270]);
      assert.ok(fill.source.endsWith("/baili-fill.jpg"));
      assert.equal(fill.filter, "none");
      await page.setViewportSize({ width: 1200, height: 800 });
      await page.locator("#loading video").evaluate((video) => {
        video.currentTime = 14;
      });
      await page.waitForFunction(() => {
        const v = document.querySelector("#loading video");
        return v?.currentTime >= 13.95 && !v.seeking;
      });
      await page.screenshot({ path: resolve(artifacts, "baili-complete-soft-fill.png") });
      await page.setViewportSize({ width: 2200, height: 1400 });
      assert.equal(
        await page.locator("#loading video").evaluate((video) => video.currentSrc),
        media.src,
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: resolve(artifacts, "baili-complete-soft-fill-portrait.png") });
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 1200, height: 800 });
    },
  );
  await t.test(
    "constrained Canvas keeps its clock while limiting pixels and drawing frequency",
    async () => {
      await navigate("off", true);
      const result = await page.evaluate(async () => {
        const { createStartupScene } = await import("/src/startup/scene.ts");
        const oldCores = Object.getOwnPropertyDescriptor(navigator, "hardwareConcurrency");
        Object.defineProperty(navigator, "hardwareConcurrency", { configurable: true, value: 4 });
        const container = document.createElement("div");
        Object.assign(container.style, {
          width: "1920px",
          height: "1080px",
          position: "absolute",
          top: "0",
        });
        document.body.append(container);
        let frames = 0,
          elapsed = 0;
        const scene = createStartupScene(
          container,
          {},
          {
            preset: "custom",
            onTime: (time) => {
              frames++;
              elapsed = time;
            },
          },
        );
        try {
          await scene.ready;
          scene.play();
          await new Promise((resolve) => setTimeout(resolve, 1000));
          scene.pause();
          const canvas = container.querySelector("canvas");
          const result = { pixels: canvas.width * canvas.height, frames, elapsed };
          await new Promise((resolve) => setTimeout(resolve, 100));
          result.framesAfterPause = frames;
          return result;
        } finally {
          scene.dispose();
          container.remove();
          if (oldCores) Object.defineProperty(navigator, "hardwareConcurrency", oldCores);
          else delete navigator.hardwareConcurrency;
        }
      });
      assert.ok(result.pixels <= 1280 * 720);
      assert.ok(result.frames >= 3 && result.frames <= 33, JSON.stringify(result));
      assert.ok(result.elapsed >= 0.7 && result.elapsed < 2.5, JSON.stringify(result));
      assert.equal(result.frames, result.framesAfterPause);
      assert.equal(await page.locator("canvas").count(), 0);
    },
  );
}
