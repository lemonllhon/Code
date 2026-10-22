import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "project archive/restore and permanent deletion work through production sidebar menus",
  { timeout: 180000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    await mkdir(".artifacts/project-lifecycle", { recursive: true });
    for (const [width, english] of [
      [1280, false],
      [390, true],
    ]) {
      const page = await browser.newPage({
        viewport: { width, height: 1000 },
        isMobile: width === 390,
        hasTouch: width === 390,
      });
      page.setDefaultTimeout(10000);
      page.setDefaultNavigationTimeout(45000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(
        `http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html?project-lifecycle${english ? "&english" : ""}`,
      );
      const row = page.getByRole("button", { name: "网站项目", exact: true });
      await row.waitFor();
      await page.getByText("本地项目会话", { exact: true }).waitFor();
      const archiveLabel = english ? "Archive project" : "归档项目";
      const deleteLabel = english ? "Delete project…" : "删除项目…";
      await row.click({ button: "right" });
      assert.equal(
        await page
          .getByRole("menuitem", { name: english ? "Remove" : "移除", exact: true })
          .count(),
        0,
      );
      await page.getByRole("menuitem", { name: archiveLabel, exact: true }).click();
      await row.waitFor({ state: "hidden" });
      assert.equal(await page.getByText("本地项目会话", { exact: true }).count(), 0);
      assert.equal(await page.getByText("置顶会话", { exact: true }).count(), 0);
      await page.getByTestId("sidebar-archive-toggle").click();
      const archived = page.getByTestId("archived-project-project");
      await archived.waitFor();
      assert.equal(
        await page.evaluate(() =>
          globalThis.__sidebarOrganization.calls.some(
            (call) => call.method === "deleteWorkspaceTasks",
          ),
        ),
        false,
      );
      await page.screenshot({ path: `.artifacts/project-lifecycle/archive-${width}.png` });
      await page.reload();
      await page.getByTestId("sidebar-archive-toggle").click();
      await archived.waitFor();
      await archived
        .getByRole("button", { name: english ? "Restore project" : "恢复项目", exact: true })
        .click();
      await archived.waitFor({ state: "hidden" });
      await page.getByTestId("sidebar-archive-toggle").click();
      await row.waitFor();
      await page.getByText("本地项目会话", { exact: true }).waitFor();
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: deleteLabel, exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      assert.match(
        await dialog.textContent(),
        english ? /Source folders on disk are kept/ : /源码目录会保留/,
      );
      await page.screenshot({ path: `.artifacts/project-lifecycle/delete-${width}.png` });
      await dialog.getByRole("button", { name: new RegExp(english ? "Cancel" : "取消") }).click();
      await dialog.waitFor({ state: "detached" });
      assert.equal(
        await page.evaluate(
          () =>
            globalThis.__sidebarOrganization.calls.filter(
              (call) => call.method === "deleteWorkspaceTasks",
            ).length,
        ),
        0,
      );
      await page.evaluate(() => globalThis.__sidebarOrganization.rejectDeletion(true));
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: deleteLabel, exact: true }).click();
      await dialog
        .getByRole("button", { name: new RegExp(english ? "Delete permanently" : "永久删除") })
        .click();
      await dialog.waitFor({ state: "detached" });
      await page.waitForFunction(() =>
        globalThis.__sidebarOrganization.calls.some(
          (call) => call.method === "deleteWorkspaceTasks",
        ),
      );
      await row.waitFor();
      assert.equal(
        await page.evaluate(() =>
          globalThis.__sidebarOrganization.calls.some(
            (call) => call.method === "project" && call.params.type === "remove",
          ),
        ),
        false,
      );
      await page.evaluate(() => globalThis.__sidebarOrganization.rejectDeletion(false));
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: deleteLabel, exact: true }).click();
      await dialog
        .getByRole("button", { name: new RegExp(english ? "Delete permanently" : "永久删除") })
        .click();
      await row.waitFor({ state: "hidden" });
      const calls = await page.evaluate(() => globalThis.__sidebarOrganization.calls);
      const purge = calls.findIndex((call) => call.method === "deleteWorkspaceTasks");
      const remove = calls.findIndex(
        (call) => call.method === "project" && call.params.type === "remove",
      );
      assert.ok(purge >= 0 && remove > purge);
      await page.getByRole("button", { name: "远程服务", exact: true }).waitFor();
      await page.reload();
      await page.getByRole("button", { name: "远程服务", exact: true }).waitFor();
      assert.equal(await row.count(), 0);
      assert.deepEqual(errors, []);
      await page.close();
    }
  },
);

test(
  "legacy implicit projects delete their recent records and do not return after reload",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(
      `http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html?project-lifecycle&implicit-project`,
    );
    const row = page.getByRole("button", { name: "网站项目", exact: true });
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "删除项目…", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /永久删除/ })
      .click();
    await row.waitFor({ state: "hidden" });
    assert.deepEqual(
      await page.evaluate(() => globalThis.__sidebarOrganization.settings().recentProjects),
      [],
    );
    await page.reload();
    await page.getByRole("button", { name: "远程服务", exact: true }).waitFor();
    assert.equal(await row.count(), 0);
  },
);

test(
  "archiving a project hides its worktrees and preserves its custom section placement",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html`);
    const project = page.getByRole("button", { name: "网站项目", exact: true });
    await page.getByText("登录优化", { exact: true }).waitFor();
    await project.click({ button: "right" });
    assert.equal(
      await page.getByRole("menuitem", { name: "删除项目…", exact: true }).isDisabled(),
      true,
    );
    await page.getByRole("menuitem", { name: "新建分区并移入…", exact: true }).click();
    const dialog = page.getByTestId("sidebar-organization-dialog");
    await dialog.getByLabel("分区名称", { exact: true }).fill("项目收纳");
    await dialog.getByRole("button", { name: "确定", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    const before = await page.evaluate(() => globalThis.__sidebarOrganization.snapshot().sections);
    await project.click({ button: "right" });
    await page.getByRole("menuitem", { name: "归档项目", exact: true }).click();
    await project.waitFor({ state: "hidden" });
    assert.equal(await page.getByText("登录优化", { exact: true }).count(), 0);
    await page.getByText("远程修复", { exact: true }).waitFor();
    assert.deepEqual(
      await page.evaluate(() => globalThis.__sidebarOrganization.snapshot().sections),
      before,
    );
    await page.getByTestId("sidebar-archive-toggle").click();
    await page
      .getByTestId("archived-project-project")
      .getByRole("button", { name: "恢复项目", exact: true })
      .click();
    await page.getByTestId("sidebar-archive-toggle").click();
    await project.waitFor();
    await page.getByText("登录优化", { exact: true }).waitFor();
    assert.deepEqual(
      await page.evaluate(() => globalThis.__sidebarOrganization.snapshot().sections),
      before,
    );
  },
);
