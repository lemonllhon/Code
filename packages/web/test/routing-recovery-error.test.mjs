import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

for (const [width, locale, theme] of [
  [1280, "zh-CN", "dark"],
  [390, "en-US", "light"],
])
  test(
    `SR-07 routing recovery errors, details and copy (${width}, ${locale})`,
    { timeout: 90000 },
    async (t) => {
      const { browser, port } = await startWorkflowProgressBrowser(t);
      const page = await browser.newPage({ viewport: { width, height: 850 } });
      page.setDefaultTimeout(8000);
      // 首次加载需要 Vite 编译完整共享工具栏；交互断言仍保持原 8 秒边界。
      page.setDefaultNavigationTimeout(30000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(
        `http://127.0.0.1:${port}/test/fixtures/routing-recovery-error.html?locale=${locale}&theme=${theme}`,
      );
      const banner = page.locator('[data-error-code="MODEL_REQUEST_FAILED"]');
      const retry = page.getByTestId("model-retry-progress");
      await retry
        .getByText(
          locale === "zh-CN" ? "正在重试模型请求... 5/10" : "Retrying model request... 5/10",
          { exact: true },
        )
        .waitFor();
      const phrases =
        locale === "zh-CN"
          ? {
              cooling: "连接暂时冷却",
              probing: "连接正在恢复探测",
              uncertain: "上次请求的结束状态尚未确认",
              exhausted: "本次自动重试已结束",
              legacy: "连接路由暂不可用",
              busy: "当前连接正在处理其他请求",
              quota: "当前连接暂无可用配额",
              dispatch: "本次请求是否已发出尚未确认",
            }
          : {
              cooling: "The connection is cooling down",
              probing: "The connection is being tested for recovery",
              uncertain: "The previous request has not been confirmed as ended",
              exhausted: "Automatic retries have ended",
              legacy: "The connection route is temporarily unavailable",
              busy: "The connection is handling another request",
              quota: "The connection has no available quota",
              dispatch: "Request dispatch has not been confirmed",
            };
      for (const state of [
        "cooling",
        "probing",
        "uncertain",
        "exhausted",
        "legacy",
        "busy",
        "quota",
        "dispatch",
      ]) {
        await page.getByTestId(`state-${state}`).click();
        await banner.getByText(phrases[state], { exact: false }).waitFor();
        assert.ok(
          await banner
            .getByText(phrases[state], { exact: false })
            .evaluate((node) => node.scrollWidth <= node.clientWidth),
          "routing state must remain readable on mobile",
        );
        assert.equal((await banner.textContent()).includes("Connection routing:"), false);
        if (state === "uncertain" || state === "exhausted") {
          await banner
            .getByRole("button", { name: locale === "zh-CN" ? "展开详情" : "Show details" })
            .click();
          const dialog = page.getByRole("dialog");
          await dialog.waitFor();
          const content = await dialog.textContent();
          assert.ok(content.includes(`recoveryState=${state === "exhausted" ? "cooling" : state}`));
          assert.ok(content.includes("scope=model"));
          if (state === "exhausted") assert.ok(content.includes("retryDisposition=exhausted"));
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "detached" });
        }
      }
      await page.getByTestId("state-uncertain").click();
      await banner
        .getByRole("button", { name: locale === "zh-CN" ? "复制" : "Copy", exact: true })
        .click();
      await page
        .getByTestId("copied-error")
        .getByText("recoveryState=uncertain", { exact: false })
        .waitFor({ state: "attached" });
      await mkdir(".tmp/routing-recovery-ui", { recursive: true });
      await page.screenshot({
        path: `.tmp/routing-recovery-ui/${width}-${locale}.png`,
        fullPage: true,
      });
      await page.getByTestId("state-429").click();
      await banner.getByText("Upstream HTTP 429", { exact: true }).waitFor();
      await page.getByTestId("state-missing-model").click();
      const missingModel = page.locator('[data-error-code="MODEL_CONFIG_MISSING"]');
      await missingModel
        .getByText(
          locale === "zh-CN"
            ? "当前没有可用模型。请配置自定义模型。"
            : "No model available. Set a custom model.",
          { exact: true },
        )
        .waitFor();
      assert.equal((await missingModel.textContent()).includes(phrases.cooling), false);
      assert.deepEqual(errors, []);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    },
  );
