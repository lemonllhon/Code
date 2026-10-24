import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

for (const mobile of [false, true])
  test(
    `usage aliases edit, validate, reload and remove (${mobile ? "mobile English" : "desktop Chinese"})`,
    { timeout: 120000 },
    async (t) => {
      const { browser, port } = await startWorkflowProgressBrowser(t);
      const page = await browser.newPage({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(
        `http://127.0.0.1:${port}/test/fixtures/usage-analytics.html${mobile ? "?locale=en-US&theme=light" : ""}`,
      );
      const open = async () => {
        const editor = page.getByTestId("usage-model-aliases");
        await editor.locator("summary").click();
        return editor;
      };
      let editor = await open();
      await editor.getByTestId("usage-alias-source").fill("shared-model");
      await editor.getByTestId("usage-alias-target").fill("Display family");
      await editor.getByTestId("usage-alias-save").click();
      await editor.locator('[data-model-alias="shared-model"]').waitFor();
      await page.waitForFunction(
        () => window.__analytics.last?.modelAliases?.["shared-model"] === "Display family",
      );
      // Same-name mapping must remain a validation failure, with saved data unchanged.
      await editor.getByTestId("usage-alias-source").fill("cycle");
      await editor.getByTestId("usage-alias-target").fill("cycle");
      await editor.getByTestId("usage-alias-save").click();
      await editor.getByRole("alert").waitFor();
      assert.equal(await page.evaluate(() => window.__analytics.aliasWrites.length), 1);
      await page.reload();
      editor = await open();
      await editor.locator('[data-model-alias="shared-model"]').waitFor();
      // Alias is available as the filter option; raw account directory IDs do not duplicate it.
      await page.getByRole("combobox", { name: mobile ? "Model" : "模型", exact: true }).click();
      const option = page.getByRole("option", { name: "Display family", exact: true });
      await option.waitFor();
      await option.click();
      await page.waitForFunction(() => window.__analytics.last?.modelId === "Display family");
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await editor.locator('[data-model-alias="shared-model"]').getByRole("button").click();
      await editor.locator('[data-model-alias="shared-model"]').waitFor({ state: "detached" });
      await page.waitForFunction(
        () => Object.keys(window.__analytics.last?.modelAliases ?? {}).length === 0,
      );
      assert.deepEqual(errors, []);
    },
  );

test(
  "late alias save is confined to its original Host and cannot clear the new Host draft",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/usage-analytics.html`);
    const editor = page.getByTestId("usage-model-aliases");
    await editor.locator("summary").click();
    await editor.getByTestId("usage-alias-source").fill("old-host");
    await editor.getByTestId("usage-alias-target").fill("Old family");
    await page.evaluate(() => {
      window.__analytics.holdAliasSave = true;
    });
    await editor.getByTestId("usage-alias-save").click();
    await page.waitForFunction(() => window.__analytics.aliasSavePending);
    await page.evaluate(() => window.__analytics.switchHost());
    await editor.getByTestId("usage-alias-source").fill("new-host");
    await editor.getByTestId("usage-alias-target").fill("New family");
    await page.evaluate(() => window.__analytics.releaseAliasSave());
    await page.waitForFunction(() => window.__analytics.aliasWrites.length === 1);
    assert.equal(await editor.getByTestId("usage-alias-source").inputValue(), "new-host");
    assert.equal(await editor.locator('[data-model-alias="old-host"]').count(), 0);
    await editor.getByTestId("usage-alias-save").click();
    await editor.locator('[data-model-alias="new-host"]').waitFor();
    assert.deepEqual(
      await page.evaluate(() => window.__analytics.aliasWrites.map((write) => write.host)),
      ["first", "second"],
    );
  },
);
