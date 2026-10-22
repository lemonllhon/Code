import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";
test(
  "automatic backup tabs, selected providers, restore preview, deletion and mobile layouts",
  { timeout: 180_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(15_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/automatic-backup.html`);
    await page.getByRole("tab", { name: "供应商备份", exact: true }).click();
    const panel = page.getByTestId("backup-lifecycle-providers");
    await panel.getByRole("button", { name: "立即备份", exact: true }).click();
    await panel.getByRole("status").filter({ hasText: "备份完成" }).first().waitFor();
    assert.equal(await panel.getByTestId("backup-version").count(), 1);
    await panel.getByRole("button", { name: "立即备份", exact: true }).click();
    await panel.getByRole("status").filter({ hasText: "无变化" }).first().waitFor();
    assert.equal(await panel.getByTestId("backup-version").count(), 1);
    await panel.getByRole("checkbox", { name: "只备份勾选项", exact: true }).click();
    await panel.getByRole("checkbox", { name: "Fixture One", exact: true }).click();
    await panel.getByRole("button", { name: "立即备份", exact: true }).click();
    await panel.getByTestId("backup-version").filter({ hasText: "部分范围" }).waitFor();
    await panel
      .getByTestId("backup-version")
      .first()
      .getByRole("button", { name: "还原", exact: true })
      .click();
    await page.getByRole("dialog").getByRole("button", { name: "预览还原", exact: true }).click();
    const confirmation = page.getByRole("dialog");
    await confirmation.getByRole("heading", { name: "确认还原" }).waitFor();
    assert.equal(await page.locator("#restored-count").innerText(), "0");
    await confirmation.getByRole("button", { name: "确认还原", exact: true }).click();
    await panel.getByRole("status").filter({ hasText: "还原完成" }).waitFor();
    assert.equal(await page.locator("#restored-count").innerText(), "1");
    await panel
      .getByTestId("backup-version")
      .first()
      .getByRole("button", { name: "删除副本", exact: true })
      .click();
    await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(await panel.getByTestId("backup-version").count(), 2);
    await panel
      .getByTestId("backup-version")
      .first()
      .getByRole("button", { name: "删除副本", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认删除备份副本", exact: true })
      .click();
    await panel.getByRole("status").filter({ hasText: "已删除" }).waitFor();
    assert.equal(await panel.getByTestId("backup-version").count(), 1);
    await panel.getByLabel("导入恢复工具包", { exact: true }).setInputFiles({
      name: "oversized.json",
      mimeType: "application/json",
      buffer: Buffer.alloc(1024 * 1024 + 1),
    });
    await panel.getByRole("alert").filter({ hasText: "exceeds the size limit" }).waitFor();
    await panel.getByRole("button", { name: "读取版本", exact: true }).click();
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="backup-lifecycle-providers"] button')?.disabled,
    );
    const directory = fileURLToPath(
      new URL("../../../.lcode/component-quality/automatic-backup/", import.meta.url),
    );
    await mkdir(directory, { recursive: true });
    for (const width of [1280, 390])
      for (const theme of ["zai-dark", "zai-light"]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate((theme) => {
          document.documentElement.className = `${theme === "zai-dark" ? "dark " : ""}theme-${theme}`;
        }, theme);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.getByRole("tab", { name: "供应商备份", exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${directory}/${width}-${theme}.png`, fullPage: true });
      }
    await page.getByLabel("Language").selectOption("en-US");
    await page.getByRole("tab", { name: "Provider backup", exact: true }).click();
    await page
      .getByTestId("backup-lifecycle-providers")
      .getByRole("button", { name: "Back up now", exact: true })
      .waitFor();
    assert.deepEqual(errors, []);
    await page.close();
  },
);
