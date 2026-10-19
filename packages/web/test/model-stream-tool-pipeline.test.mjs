import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "pipeline rows preserve one reasoning row, actual running tools and stopped state after remount",
  { timeout: 120_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const width of [1280, 390])
      await t.test(`${width}px`, async () => {
        const page = await browser.newPage({
          viewport: { width, height: 800 },
          reducedMotion: "reduce",
        });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(
          `http://127.0.0.1:${port}/test/fixtures/conversation-send.html?pipelineRows`,
        );
        await page.locator('[data-row-id="13"]').waitFor();
        assert.equal(await page.locator('[data-testid="chat-reasoning-trigger"]').count(), 1);
        assert.equal(await page.locator("[data-row-id]").count(), 13);
        // pending 也沿用活动动画；运行事实必须读取工具卡已公开的状态，不能拿 CSS 推断。
        const running = () =>
          page.locator('[data-tool-call-id][data-status="in_progress"]').count();
        assert.equal(await running(), 2);
        assert.equal(await page.locator('[data-tool-call-id][data-status="pending"]').count(), 10);
        await page.evaluate(() => globalThis.__pipelineRows.refill());
        await page.waitForSelector('[data-stage="refill"]');
        assert.equal(
          await page.locator('[data-tool-call-id="read-0"]').getAttribute("data-status"),
          "completed",
        );
        assert.equal(
          await page.locator('[data-tool-call-id="read-2"]').getAttribute("data-status"),
          "in_progress",
        );
        assert.equal(await running(), 2);
        await page.evaluate(() => globalThis.__pipelineRows.stop());
        await page.waitForSelector('[data-stage="stopped"]');
        assert.equal(await running(), 0);
        await page.evaluate(() => globalThis.__pipelineRows.switchSession());
        await page.locator('[data-testid="other-session"]').waitFor();
        await page.evaluate(() => globalThis.__pipelineRows.switchSession());
        await page.locator('[data-row-id="13"]').waitFor();
        assert.equal(await running(), 0);
        assert.equal(await page.locator("[data-row-id]").count(), 13);
        await page.locator('[data-testid="chat-reasoning-trigger"]').click();
        await page.waitForFunction(() =>
          document
            .querySelector("[data-reasoning-content]")
            ?.textContent?.includes("fragment-2255"),
        );
        const content = await page.locator("[data-reasoning-content]").textContent();
        assert.ok(content.includes("fragment-0 ") && content.includes("fragment-2255"));
        assert.deepEqual(errors, []);
        await page.close();
      });
  },
);
