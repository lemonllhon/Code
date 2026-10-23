import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

for (const width of [1280, 390])
  test(
    `SR-11 independent / child retry views stay isolated (${width}px)`,
    { timeout: 90000 },
    async (t) => {
      const { browser, port } = await startWorkflowProgressBrowser(t);
      const page = await browser.newPage({ viewport: { width, height: 850 } });
      page.setDefaultTimeout(8000);
      page.setDefaultNavigationTimeout(30000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(
        `http://127.0.0.1:${port}/test/fixtures/conversation-send.html?retrySessions`,
      );
      const view = page.getByTestId("view-session");
      const retry = page.locator('[data-lcode-chat-loading-slot="true"]');
      await retry.getByText("正在重试模型请求... 5/10", { exact: true }).waitFor();
      for (const [session, attempt] of [
        ["independent", 7],
        ["child", 9],
        ["parent", 5],
      ]) {
        await page.getByTestId(`view-${session}`).click();
        await view.getByText(session, { exact: true }).waitFor();
        await retry.getByText(`正在重试模型请求... ${attempt}/10`, { exact: true }).waitFor();
      }
      await page.evaluate(() => globalThis.__retrySessions.update("child", null));
      await retry.getByText("正在重试模型请求... 5/10", { exact: true }).waitFor();
      await page.getByTestId("view-child").click();
      await view.getByText("child", { exact: true }).waitFor();
      assert.equal((await retry.textContent()).includes("正在重试"), false);
      await page.evaluate(() => globalThis.__retrySessions.update("independent", 8));
      await page.getByTestId("view-independent").click();
      await retry.getByText("正在重试模型请求... 8/10", { exact: true }).waitFor();
      assert.equal(
        await page.evaluate(() => globalThis.__retrySessions.subscriptions()),
        3,
        "view changes must not resubscribe or send another model request",
      );
      assert.deepEqual(errors, []);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    },
  );
