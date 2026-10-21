import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test("编辑项目从 Git 向导关联源目录，保存/取消和失败重试边界", { timeout: 120000 }, async (t) => {
  const { browser, port } = await startWorkflowProgressBrowser(t);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/test/fixtures/project-form.html?theme=zai-light`);
  const project = () =>
    page.evaluate(() => globalThis.__sidebarOrganization.settings().localProjects[0]);
  const calls = () => page.evaluate(() => globalThis.__sidebarOrganization.calls());
  const open = async () => {
    await page.getByText("网站项目", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "编辑项目…", exact: true }).click();
    await page.getByTestId("sidebar-project-editor").getByRole("textbox").first().waitFor();
  };
  const wizard = async () => {
    await page.getByTestId("project-git-repository").click();
    assert.equal(await page.getByRole("dialog").count(), 1);
  };
  const next = () => page.getByTestId("git-repository-next").click();
  const prepare = async (name) => {
    await wizard();
    await next();
    await page.getByRole("textbox", { name: "目录路径", exact: true }).fill("/fixture");
    await next();
    await page
      .getByRole("textbox", { name: "仓库地址", exact: true })
      .fill("https://example.invalid/repository.git");
    await page.getByRole("textbox", { name: "新目录名称", exact: true }).fill(name);
    await next();
  };
  await open();
  await prepare("cloned");
  await page.evaluate(() => globalThis.__sidebarOrganization.failNextGitFolderAdd());
  await page.getByTestId("git-import-confirm").click();
  await page.getByTestId("git-repository-add-error").waitFor();
  assert.equal((await calls()).filter((c) => c.method === "acquireRepository").length, 1);
  await page.getByTestId("git-repository-attach").click();
  const editor = page.getByTestId("sidebar-project-editor");
  await editor.waitFor();
  assert.equal(await editor.locator("[data-project-member]").count(), 2);
  assert.equal((await project()).sourceFolderPaths.length, 1);
  assert.equal(await editor.getByRole("button", { name: /设为主文件夹/ }).count(), 0);
  assert.equal(
    await editor
      .locator('[data-project-member="/fixture/repo"]')
      .getByRole("button", { name: "repo · 移除目录", exact: true })
      .isDisabled(),
    true,
  );
  await mkdir("artifacts/project-git-integration", { recursive: true });
  await page.screenshot({
    path: "artifacts/project-git-integration/editor-added.png",
    animations: "disabled",
  });
  await editor.getByRole("button", { name: "取消", exact: true }).click();
  assert.deepEqual((await project()).sourceFolderPaths, ["/fixture/repo"]);
  await open();
  await prepare("cloned-second");
  await page.getByTestId("git-import-confirm").click();
  await editor.waitFor();
  const row = editor.locator('[data-project-member="/fixture/cloned-second"]');
  await row.getByRole("button", { name: /用途和说明/ }).click();
  await row.getByRole("textbox").fill("本地服务仓库");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await editor.waitFor({ state: "detached" });
  assert.deepEqual((await project()).sourceFolderPaths, [
    "/fixture/repo",
    "/fixture/cloned-second",
  ]);
  assert.equal((await project()).primaryFolderPath, "/fixture/repo");
  await open();
  await editor
    .locator('[data-project-member="/fixture/cloned-second"]')
    .getByText("本地服务仓库", { exact: true })
    .waitFor();
  await wizard();
  await page.getByRole("button", { name: "初始化仓库", exact: true }).click();
  await next();
  assert.equal(
    await page.getByRole("textbox", { name: "目录路径", exact: true }).inputValue(),
    "/fixture/repo",
  );
  await next();
  await next();
  await page.getByTestId("git-import-confirm").click();
  await editor.waitFor();
  assert.equal(await editor.locator("[data-project-member]").count(), 2);
  assert.equal((await calls()).filter((c) => c.method === "acquireRepository").length, 3);
  assert.deepEqual(errors, []);
});
