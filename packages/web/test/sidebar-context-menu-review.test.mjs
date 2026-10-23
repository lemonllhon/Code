import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

const menuItem = (page, name) => page.getByRole("menuitem", { name, exact: true });
async function openMenu(page, title, touch = false) {
  await page.locator('[data-slot="context-menu-content"]').waitFor({ state: "detached" });
  const row = page
    .locator("[data-task-item-key]")
    .filter({ has: page.getByText(title, { exact: true }) });
  if (touch) {
    await row.tap();
    await row.getByRole("button", { name: "更多", exact: true }).tap();
  } else await row.click({ button: "right" });
}

for (const kind of ["ssh", "wsl"])
  test(
    `local file actions stay local beside a same-path ${kind} project`,
    { timeout: 120000 },
    async (t) => {
      const { browser, port } = await startWorkflowProgressBrowser(t);
      const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
      page.setDefaultTimeout(10000);
      page.setDefaultNavigationTimeout(45000);
      await page.goto(
        `http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html?desktop=1${kind === "wsl" ? "&wsl=1" : ""}`,
      );
      await openMenu(page, "本地项目会话");
      await menuItem(page, "更多操作").hover();
      const localAction = page.getByRole("menuitem", { name: /在.*中打开$/ });
      assert.notEqual(await localAction.getAttribute("aria-disabled"), "true");
      await localAction.click();
      const call = await page.evaluate(() =>
        globalThis.__sidebarOrganization.calls.find(
          (item) => item.method === "open-editor" || item.method === "open-native-folder",
        ),
      );
      assert.equal(call.params.path, "/fixture/repo");
      assert.equal(call.params.options?.remoteTarget, undefined);
      await openMenu(page, "远程项目会话");
      await menuItem(page, "更多操作").hover();
      const remoteAction = page.getByRole("menuitem", { name: /在.*中打开$/ });
      assert.equal((await remoteAction.getAttribute("aria-disabled")) === "true", kind === "ssh");
      await mkdir(".artifacts/sidebar-context-menu-review", { recursive: true });
      await page.screenshot({
        path: `.artifacts/sidebar-context-menu-review/remote-file-menu-${kind}.png`,
        animations: "disabled",
      });
      if (kind === "wsl") {
        await remoteAction.click();
        const opened = await page.evaluate(() =>
          globalThis.__sidebarOrganization.calls
            .filter((item) => item.method === "open-editor")
            .at(-1),
        );
        assert.equal(opened.params.path, "/fixture/repo");
        assert.equal(opened.params.options.pathKind, "directory");
        assert.equal(opened.params.options.remoteTarget.kind, "wsl");
        assert.equal(
          opened.params.options.workspaceIdentity,
          await page.evaluate(() => globalThis.__sidebarOrganization.identity),
        );
      }
    },
  );

for (const width of [1280, 390]) {
  test(
    `chat menu failures preserve facts and allow retry at ${width}px`,
    { timeout: 180000 },
    async (t) => {
      const { browser, port } = await startWorkflowProgressBrowser(t);
      const touch = width === 390;
      const page = await browser.newPage({
        viewport: { width, height: 1000 },
        isMobile: touch,
        hasTouch: touch,
      });
      page.setDefaultTimeout(10000);
      page.setDefaultNavigationTimeout(45000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const url = `http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html`;
      for (const [initialTitle, taskId] of [
        ["本地项目会话", "local"],
        ["工作树子会话", "child"],
        ["置顶会话", "pinned"],
        ["远程项目会话", "remote"],
      ]) {
        await page.goto(url);
        let title = initialTitle;
        await page
          .locator("[data-task-item-key]")
          .filter({ has: page.getByText(title, { exact: true }) })
          .waitFor();
        const original = await page.evaluate(
          (id) => globalThis.__sidebarOrganization.tasks().find((task) => task.taskId === id),
          taskId,
        );
        await page.evaluate(() => {
          globalThis.__sidebarOrganization.menuControl.failMutation = "pin-task";
        });
        await openMenu(page, title, touch);
        await menuItem(page, original.pinnedAt ? "取消置顶任务" : "置顶任务").click();
        await page.getByText("更新置顶状态失败", { exact: true }).waitFor();
        await openMenu(page, title, touch);
        await menuItem(page, original.pinnedAt ? "取消置顶任务" : "置顶任务").waitFor();
        await page.keyboard.press("Escape");
        assert.deepEqual(
          await page.evaluate(
            (id) => globalThis.__sidebarOrganization.tasks().find((task) => task.taskId === id),
            taskId,
          ),
          original,
        );
        await page.evaluate(() => {
          globalThis.__sidebarOrganization.menuControl.failMutation = "rename-task";
        });
        await openMenu(page, title, touch);
        await menuItem(page, "重命名任务").click();
        const dialog = page.getByRole("dialog");
        const newTitle = `${initialTitle}（已重命名）`;
        await dialog.getByRole("textbox").fill(newTitle);
        await dialog.getByRole("button", { name: "确认", exact: true }).click();
        await page.getByText("重命名任务失败", { exact: true }).waitFor();
        assert.equal(await dialog.getByRole("textbox").inputValue(), newTitle);
        assert.deepEqual(errors, []);
        await page.evaluate(() => {
          globalThis.__sidebarOrganization.menuControl.failMutation = "";
        });
        await dialog.getByRole("button", { name: "确认", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        title = newTitle;
        await page
          .locator("[data-task-item-key]")
          .filter({ has: page.getByText(title, { exact: true }) })
          .waitFor();
        for (const [method, label, failure] of [
          ["unread-task", "标记为未读", "标记未读失败"],
          ["archive-task", "归档任务", "归档任务失败"],
        ]) {
          const previous = await page.evaluate(
            (id) => globalThis.__sidebarOrganization.tasks().find((task) => task.taskId === id),
            taskId,
          );
          await page.evaluate((method) => {
            globalThis.__sidebarOrganization.menuControl.failMutation = method;
          }, method);
          await openMenu(page, title, touch);
          await menuItem(page, label).click();
          await page.getByText(failure, { exact: true }).waitFor();
          if (taskId === "child" && method === "unread-task") {
            await mkdir(".artifacts/sidebar-context-menu-review", { recursive: true });
            await page.screenshot({
              path: `.artifacts/sidebar-context-menu-review/failure-${width}.png`,
              animations: "disabled",
            });
          }
          const task = await page.evaluate(
            (id) => globalThis.__sidebarOrganization.tasks().find((task) => task.taskId === id),
            taskId,
          );
          assert.deepEqual(task, previous, `${taskId}: rejected ${method} preserves facts`);
          assert.deepEqual(errors, []);
          await page.evaluate(() => {
            globalThis.__sidebarOrganization.menuControl.failMutation = "";
          });
          await openMenu(page, title, touch);
          await menuItem(page, label).click();
          await page.waitForFunction(
            ({ id, field }) =>
              Boolean(
                globalThis.__sidebarOrganization.tasks().find((task) => task.taskId === id)?.[
                  field
                ],
              ),
            { id: taskId, field: method === "unread-task" ? "unreadAt" : "archivedAt" },
          );
        }
        const routed = await page.evaluate(
          (id) =>
            globalThis.__sidebarOrganization.calls.filter((call) => call.params?.taskId === id),
          taskId,
        );
        for (const call of routed) {
          assert.equal(call.params.workspacePath, "/fixture/repo");
          assert.equal(
            call.params.workspaceIdentity,
            taskId === "remote"
              ? await page.evaluate(() => globalThis.__sidebarOrganization.identity)
              : undefined,
          );
        }
        await page.getByText("登录优化", { exact: true }).waitFor();
        await page
          .locator('[data-binding-id="tree-a"]')
          .getByRole("img", { name: "工作树可用", exact: true })
          .waitFor();
      }
      assert.deepEqual(errors, []);
      await page.close();
    },
  );
}
