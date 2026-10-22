import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";
const createId = "create-project-dialog";
const rowAt = (dialog, path) => dialog.locator(`[data-project-member="${path}"]`);

test(
  "primary changes update the badge and first row, and pointer/keyboard sorting survives save and reload",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/project-form.html`);
    await page.evaluate(() =>
      globalThis.__sidebarOrganization.selectCreationBatch([
        "/fixture/front",
        "/fixture/back",
        "/fixture/docs",
      ]),
    );
    await page.getByRole("button", { name: "新建项目", exact: true }).click();
    let dialog = page.getByTestId(createId);
    await dialog.getByTestId("create-project-add-folder").click();
    await dialog.getByLabel("项目名称", { exact: true }).fill("目录排序项目");
    await rowAt(dialog, "/fixture/back")
      .getByRole("button", { name: /设为主文件夹/ })
      .click();
    const ordered = async () =>
      dialog
        .locator("[data-project-member]")
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-project-member")));
    assert.deepEqual(await ordered(), ["/fixture/back", "/fixture/front", "/fixture/docs"]);
    assert.equal(
      await rowAt(dialog, "/fixture/back").getByText("主要", { exact: true }).count(),
      1,
    );
    assert.equal(await dialog.getByText("主要", { exact: true }).count(), 1);
    const list = dialog.getByTestId("project-folder-list");
    await list.evaluate((element) => {
      element.scrollTop = element.firstElementChild.getBoundingClientRect().height;
    });
    const handle = rowAt(dialog, "/fixture/front").locator("[data-project-sort-handle]");
    const from = await handle.boundingBox(),
      to = await rowAt(dialog, "/fixture/docs").boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 12, { steps: 3 });
    await page.mouse.move(to.x + 30, to.y + to.height / 2, { steps: 12 });
    await page.mouse.up();
    assert.deepEqual(await ordered(), ["/fixture/back", "/fixture/docs", "/fixture/front"]);
    await handle.evaluate(async (element) => {
      const row = element.closest("[data-project-member]").parentElement;
      await Promise.allSettled(
        row.getAnimations({ subtree: true }).map((animation) => animation.finished),
      );
    });
    await handle.focus();
    await page.keyboard.press("Space");
    await page.waitForFunction(
      (element) => element.getAttribute("data-dragging") === "true",
      await handle.elementHandle(),
    );
    await page.keyboard.press("ArrowUp");
    const docsId = await rowAt(dialog, "/fixture/docs")
      .locator("[data-project-sort-handle]")
      .getAttribute("data-project-sort-handle");
    await page.waitForFunction(
      (id) =>
        [...document.querySelectorAll('[role="status"]')].some((node) =>
          node.textContent.includes(`was moved over droppable area ${id}.`),
        ),
      docsId,
    );
    await page.keyboard.press("Space");
    assert.deepEqual(await ordered(), ["/fixture/back", "/fixture/front", "/fixture/docs"]);
    await dialog.getByRole("button", { name: "新建项目", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await page.reload();
    const open = async () => {
      await page.getByText("目录排序项目", { exact: true }).click({ button: "right" });
      await page.getByRole("menuitem", { name: "编辑项目…", exact: true }).click();
      dialog = page.getByTestId("sidebar-project-editor");
      await dialog.getByLabel("项目名称", { exact: true }).waitFor();
    };
    await open();
    await rowAt(dialog, "/fixture/docs")
      .getByRole("button", { name: /设为主文件夹/ })
      .click();
    assert.deepEqual(await ordered(), ["/fixture/docs", "/fixture/back", "/fixture/front"]);
    assert.equal(
      await rowAt(dialog, "/fixture/docs").getByText("主要", { exact: true }).count(),
      1,
    );
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    const saved = await page.evaluate(() =>
      globalThis.__sidebarOrganization
        .settings()
        .projectDefinitions.projects.find((project) => project.name === "目录排序项目"),
    );
    assert.equal(
      saved.primaryFolderPath,
      "/fixture/back",
      "changing primary keeps the historical identity anchor",
    );
    assert.equal(
      saved.members.find((member) => member.id === saved.primaryMemberId).path,
      "/fixture/docs",
    );
    assert.equal(saved.memberOrder[0], saved.primaryMemberId);
    await page.reload();
    await open();
    assert.deepEqual(await ordered(), ["/fixture/docs", "/fixture/back", "/fixture/front"]);
    await rowAt(dialog, "/fixture/docs")
      .getByRole("button", { name: /移除目录/ })
      .click();
    assert.deepEqual(await ordered(), ["/fixture/back", "/fixture/front"]);
    assert.equal(
      await rowAt(dialog, "/fixture/back").getByText("主要", { exact: true }).count(),
      1,
    );
    assert.equal(await dialog.getByText("主要", { exact: true }).count(), 1);
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await page.reload();
    await open();
    assert.deepEqual(await ordered(), ["/fixture/back", "/fixture/front"]);
    assert.equal(
      await rowAt(dialog, "/fixture/back").getByText("主要", { exact: true }).count(),
      1,
    );
  },
);

test(
  "folder list scrolls without editing purpose and the compact header reveals its full hint",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const menu of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(
        `http://127.0.0.1:${port}/test/fixtures/project-form.html${menu ? "?composer" : ""}`,
      );
      await page.evaluate(() =>
        globalThis.__sidebarOrganization.selectCreationBatch(
          Array.from({ length: 8 }, (_, index) => `/fixture/folder-${index}`),
        ),
      );
      if (menu) {
        await page.getByTestId("composer-workspace-trigger").click();
        await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
      } else await page.getByRole("button", { name: "新建项目", exact: true }).click();
      const dialog = page.getByTestId(createId);
      await dialog.getByTestId("create-project-add-folder").click();
      const list = dialog.getByTestId("project-folder-list");
      assert.equal(await dialog.locator("textarea").count(), 0);
      assert.equal(await dialog.getByText("点击填写用途和说明", { exact: true }).count(), 8);
      const box = await list.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + 50);
      await page.mouse.wheel(0, 300);
      await page.waitForFunction(
        () => document.querySelector('[data-testid="project-folder-list"]').scrollTop > 0,
      );
      const hint = dialog.getByTestId("project-folder-hint");
      await hint.hover();
      await page.getByRole("tooltip").filter({ hasText: "移除或取消不删文件" }).waitFor();
      const hintBox = await hint.boundingBox(),
        actionsBox = await dialog.getByTestId("project-folder-actions").boundingBox();
      assert.ok(hintBox.x + hintBox.width <= actionsBox.x + 1);
      assert.equal(await dialog.getByText("可将多个文件夹拖入此弹框", { exact: true }).count(), 0);
      await page.getByLabel("项目名称", { exact: true }).fill("滚动项目");
      await dialog.getByRole("button", { name: "新建项目", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      await page.reload();
      await page.getByText("滚动项目", { exact: true }).click({ button: "right" });
      await page.getByRole("menuitem", { name: "编辑项目…", exact: true }).click();
      const editor = page.getByTestId("sidebar-project-editor");
      const editList = editor.getByTestId("project-folder-list");
      await editor.getByLabel("项目名称", { exact: true }).waitFor();
      assert.equal(await editor.locator("textarea").count(), 0);
      const editBox = await editList.boundingBox();
      await page.mouse.move(editBox.x + editBox.width / 2, editBox.y + 50);
      await page.mouse.wheel(0, 300);
      await page.waitForFunction(
        () => document.querySelector('[data-testid="project-folder-list"]').scrollTop > 0,
      );
      await editor.getByTestId("project-folder-hint").hover();
      await page.getByRole("tooltip").filter({ hasText: "已接受的输入" }).waitFor();
      await page
        .locator('[data-slot="tooltip-content"]')
        .filter({ hasText: "已接受的输入" })
        .evaluate(async (element) => {
          await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));
        });
      await mkdir(".artifacts/project-form", { recursive: true });
      await page.screenshot({
        path: `.artifacts/project-form/compact-hint-${menu ? "composer" : "direct"}.png`,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => {
        document.documentElement.className = "theme-zai-light";
        document.documentElement.style.setProperty("--ui-font-size", "20px");
      });
      await editor.evaluate(async (element) => {
        await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));
      });
      const mobileHint = await editor.getByTestId("project-folder-hint").boundingBox();
      assert.ok(mobileHint.width >= 80, "the hint must stay accessible on narrow screens");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.emulateMedia({ reducedMotion: "reduce" });
      await editor.getByTestId("project-folder-hint").focus();
      await page.getByRole("tooltip").filter({ hasText: "已接受的输入" }).waitFor();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="project-folder-hint"] span').getAnimations()
            .length === 0,
      );
      await page.screenshot({
        path: `.artifacts/project-form/compact-hint-mobile-${menu ? "composer" : "direct"}.png`,
      });
      await page.close();
    }
  },
);
