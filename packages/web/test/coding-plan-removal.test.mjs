import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "桌面和手机保留两个独立 Coding Plan 模板及 Key 保存，无订阅入口",
  { timeout: 120_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(10_000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.goto(
          `http://127.0.0.1:${port}/test/fixtures/coding-plan-removal.html?codingPlanRemoval=1${width === 390 ? "&light=1" : ""}`,
        );
        for (const [id, label] of [
          ["zai-api", "Z.ai Coding Plan"],
          ["bigmodel-api", "BigModel Coding Plan"],
        ]) {
          await page.getByRole("button", { name: "Add provider", exact: true }).click();
          await page.getByRole("tab", { name: /API/ }).click();
          await page
            .locator('[data-testid^="model-provider-template-item"]')
            .filter({ hasText: label })
            .click();
          await page.getByRole("button", { name: /^Manage API keys/ }).click();
          const dialog = page.getByRole("dialog");
          await dialog.getByRole("button", { name: "Add key", exact: true }).click();
          await dialog
            .getByLabel("API Key 1", { exact: true })
            .fill("FIXTURE_ONLY_NOT_A_REAL_API_KEY");
          await dialog.getByRole("button", { name: "Save", exact: true }).click();
          await dialog.waitFor({ state: "detached" });
          const access = await page.evaluate(async (templateId) => {
            const view = await window.__retainedProviders.getView();
            const provider = view.providers.find((item) => item.templateId === templateId);
            return { access: provider?.effectiveConfig.access, models: provider?.models.length };
          }, id);
          assert.equal(access.access.type, "zhipu-coding-plan-api-key");
          assert.ok(
            access.access.apiKeys.some((key) => key.apiKey === "FIXTURE_ONLY_NOT_A_REAL_API_KEY"),
          );
          assert.ok(access.models > 0);
        }
        assert.equal(await page.locator("webview").count(), 0);
        assert.doesNotMatch(
          await page.locator("body").innerText(),
          /Purchase|Renew subscription|Reset quota|Team Plan|Start Plan/,
        );
        assert.deepEqual(errors, []);
      } catch (error) {
        throw new Error(
          `${error.message}\nPage errors: ${errors.join("; ")}\nPage: ${(await page.locator("body").innerText()).slice(0, 1400)}`,
          { cause: error },
        );
      } finally {
        await page.close();
      }
    }
  },
);
