import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test("会话模型配置：速度菜单、思考滑块与冻结提交", { timeout: 180_000 }, async (t) => {
  const { browser, port } = await startWorkflowProgressBrowser(t);
  for (const width of [1280, 390]) {
    for (const existing of [false, true]) {
      for (const standardOnly of [false, true]) {
        await t.test(
          `${width}px ${existing ? "已有会话" : "新会话"} ${standardOnly ? "仅标准" : "快速可选"}`,
          async () => {
            const page = await browser.newPage({ viewport: { width, height: 800 } });
            try {
              const query = new URLSearchParams();
              if (existing) query.set("existing", "");
              if (standardOnly) query.set("standardOnly", "");
              await page.goto(
                `http://127.0.0.1:${port}/test/fixtures/conversation-send.html?${query}`,
              );
              await page.getByTestId("chat-model-speed-trigger").click();
              await page.getByTestId("chat-model-speed-standard").waitFor();
              assert.equal(
                await page.getByTestId("chat-model-speed-fast").count(),
                standardOnly ? 0 : 1,
              );
              await page.getByTestId("chat-model-speed-standard").click();
              const editor = page.getByTestId("v4-composer-input");
              await editor.fill("speed regression");
              await page.waitForFunction(
                () => !document.querySelector('[data-testid="v4-composer-send"]')?.disabled,
              );
              await page.getByTestId("v4-composer-send").click();
              await page.waitForFunction(() => globalThis.__sendFixture.calls.length === 1);
              const [call] = await page.evaluate(() => globalThis.__sendFixture.calls);
              assert.deepEqual(call.options.submission.modelSelection.options, {
                reasoningLevel: "high",
                speed: "standard",
              });
            } finally {
              await page.close();
            }
          },
        );
      }
    }
  }

  for (const [width, english] of [
    [1280, false],
    [390, false],
    [320, true],
  ]) {
    await t.test(`${width}px 思考滑块无档位按钮和操作提示，轨道和键盘选档仍可提交`, async () => {
      const context = await browser.newContext({
        viewport: { width, height: 800 },
        isMobile: width < 1280,
        hasTouch: width < 1280,
      });
      const page = await context.newPage();
      try {
        const query = new URLSearchParams({ thoughtLevels: "default,low,medium,high,xhigh" });
        if (english) query.set("english", "");
        await page.goto(`http://127.0.0.1:${port}/test/fixtures/conversation-send.html?${query}`);
        if (english) {
          await page.evaluate(() =>
            document.documentElement.style.setProperty("--ui-font-size", "20px"),
          );
        }
        await page.getByTestId("chat-thought-level-select-trigger").click();
        const panel = page.getByTestId("chat-thought-level-slider-panel");
        await panel.waitFor();
        await panel.evaluate((element) =>
          Promise.all(element.getAnimations().map((animation) => animation.finished)),
        );
        assert.equal(await panel.getByRole("button").count(), 0);
        assert.equal(
          await panel
            .getByText(
              english ? "Drag, click or use arrow keys to adjust" : "拖动、点击或用方向键调整",
              { exact: true },
            )
            .count(),
          0,
        );
        const title = english ? "Thought level" : "思考级别";
        assert.equal(await panel.getByText(title, { exact: true }).count(), 1);
        const slider = page.getByRole("slider", { name: title });
        const selected = (value) =>
          page.waitForFunction((expected) => {
            const label = document.querySelector("[data-thought-level-current-label]");
            // 滚动标签在退场完成前保留旧新文字，等待实际呈现收敛。
            return (
              document.querySelector("[data-thought-levels]")?.getAttribute("data-thought") ===
                expected &&
              label?.innerText ===
                label?.querySelector("[data-toolbar-label-root]")?.getAttribute("title")
            );
          }, value);
        const track = await page.locator(".thought-level-track").boundingBox();
        assert.ok(track);
        const point = { x: track.x + track.width / 4, y: track.y + track.height / 2 };
        if (width < 1280) await page.touchscreen.tap(point.x, point.y);
        else await page.mouse.click(point.x, point.y);
        await selected("low");
        assert.equal(await slider.getAttribute("aria-valuetext"), english ? "Low" : "低");
        assert.equal(
          await panel.locator("[data-thought-level-current-label]").innerText(),
          english ? "Low" : "低",
        );
        await slider.press("End");
        await selected("xhigh");
        const artifacts = fileURLToPath(
          new URL("../../../.lcode/thought-slider/", import.meta.url),
        );
        await mkdir(artifacts, { recursive: true });
        await panel.screenshot({ path: `${artifacts}/labels-removed-${width}.png` });
        assert.equal(
          await panel.evaluate((element) => element.scrollWidth <= element.clientWidth),
          true,
        );
        const bounds = await panel.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
        await slider.press("Home");
        await selected("default");
        await slider.press("ArrowRight");
        await selected("low");
        await page.keyboard.press("Escape");
        await panel.waitFor({ state: "detached" });
        await page.getByTestId("v4-composer-input").fill("thought slider labels regression");
        await page.waitForFunction(
          () => !document.querySelector('[data-testid="v4-composer-send"]')?.disabled,
        );
        await page.getByTestId("v4-composer-send").click();
        await page.waitForFunction(() => globalThis.__sendFixture.calls.length === 1);
        const [call] = await page.evaluate(() => globalThis.__sendFixture.calls);
        assert.deepEqual(call.options.submission.modelSelection.options, {
          reasoningLevel: "low",
          speed: "fast",
        });
      } finally {
        await context.close();
      }
    });
  }
});
