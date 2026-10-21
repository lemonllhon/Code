import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test("项目内 Git 仓库向导与多源目录", { timeout: 180000 }, async (t) => {
  const { browser, port } = await startWorkflowProgressBrowser(t);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const url = `http://127.0.0.1:${port}/test/fixtures/git-workspace.html`;
  const control = (name, ...args) =>
    page.evaluate(({ name, args }) => globalThis.__gitWorkspace[name](...args), { name, args });
  const writes = () =>
    page.evaluate(() =>
      globalThis.__gitWorkspace.calls.filter((c) => c.method === "acquireRepository"),
    );
  const dialog = () => page.getByTestId("create-project-dialog");
  const open = async (query = "") => {
    await page.goto(url + query);
    await page.getByTestId("composer-workspace-trigger").click();
    assert.equal(await page.getByTestId("composer-git-repository").count(), 0);
    await page
      .getByRole("menuitem", {
        name: query.includes("english") ? "New project" : "新建项目",
        exact: true,
      })
      .click();
    await dialog().waitFor();
  };
  const wizard = async () => {
    await dialog().getByTestId("project-git-repository").click();
    await page.getByTestId("git-repository-wizard").waitFor();
    assert.equal(await page.getByRole("dialog").count(), 1);
  };
  const next = () => page.getByTestId("git-repository-next").click();
  const location = async (path = "/fixture/import") => {
    await next();
    await page.getByRole("textbox", { name: "目录路径", exact: true }).fill(path);
    assert.equal(await page.getByTestId("git-repository-group").count(), 0);
    await next();
  };
  const clone = async (name) => {
    await wizard();
    await location();
    await page
      .getByRole("textbox", { name: "仓库地址", exact: true })
      .fill("https://example.invalid/repo.git");
    await page.getByRole("textbox", { name: "新目录名称", exact: true }).fill(name);
    await next();
    await page.getByTestId("git-import-confirmation").waitFor();
    await page.getByTestId("git-import-confirm").click();
    await dialog().waitFor();
  };
  await t.test("菜单入口收回项目表单，返回保留草稿且同一弹框切换", async () => {
    await open();
    const actions = dialog().getByTestId("project-folder-actions");
    assert.deepEqual(await actions.getByRole("button").allTextContents(), ["添加目录", "Git 仓库"]);
    await dialog().getByRole("textbox", { name: "项目名称", exact: true }).fill("保留的项目");
    await wizard();
    await next();
    assert.equal(await page.getByRole("textbox", { name: "项目名称", exact: true }).count(), 0);
    await page.keyboard.press("Escape");
    assert.equal(
      await dialog().getByRole("textbox", { name: "项目名称", exact: true }).inputValue(),
      "保留的项目",
    );
    assert.deepEqual(await writes(), []);
    assert.equal(await page.getByRole("dialog").count(), 1);
  });
  await t.test("普通目录和两个仓库组成一个项目，主目录可选，保存失败不重复克隆", async () => {
    await open();
    await control("selectProjectFolders", ["/fixture/shared"]);
    await dialog().getByTestId("create-project-add-folder").click();
    await dialog().getByRole("textbox", { name: "项目名称", exact: true }).fill("综合项目");
    const shared = () => dialog().locator('[data-project-member="/fixture/shared"]');
    await shared()
      .getByRole("button", { name: /用途和说明/ })
      .click();
    await shared().getByRole("textbox").fill("共享协议");
    await shared().getByRole("checkbox", { name: "默认参与", exact: true }).uncheck();
    await clone("frontend");
    assert.equal(await dialog().locator("[data-project-member]").count(), 2);
    await clone("backend");
    assert.equal(await dialog().locator("[data-project-member]").count(), 3);
    await shared().getByText("共享协议", { exact: true }).waitFor();
    assert.equal(await shared().getByRole("checkbox").isChecked(), false);
    await dialog()
      .locator('[data-project-member="/fixture/import/frontend"]')
      .getByRole("button", { name: /设为主文件夹/ })
      .click();
    assert.equal(
      await dialog().locator("[data-project-member]").first().getAttribute("data-project-member"),
      "/fixture/import/frontend",
    );
    assert.equal((await control("registrationRequests")).length, 0);
    await control("failRegistration");
    await dialog().getByRole("button", { name: "新建项目", exact: true }).click();
    await dialog().getByRole("alert").filter({ hasText: "fixture-registration-failure" }).waitFor();
    await dialog().getByRole("button", { name: "新建项目", exact: true }).click();
    await dialog().waitFor({ state: "detached" });
    const requests = await control("registrationRequests");
    assert.equal(requests.length, 2);
    assert.ok(requests[0].projectId);
    assert.equal(requests[0].projectId, requests[1].projectId);
    assert.deepEqual(requests[1].sourceFolderPaths, [
      "/fixture/import/frontend",
      "/fixture/shared",
      "/fixture/import/backend",
    ]);
    assert.equal(requests[1].name, "综合项目");
    assert.equal(requests[1].members[1].description, "共享协议");
    assert.equal(requests[1].members[1].enabled, false);
    assert.equal((await writes()).length, 2);
  });
  await t.test("初始化既有源目录去重，嵌套保护及执行中关闭防护", async () => {
    await open();
    await control("selectProjectFolders", ["/fixture/shared"]);
    await dialog().getByTestId("create-project-add-folder").click();
    await wizard();
    await page.getByRole("button", { name: "初始化仓库", exact: true }).click();
    await location("/fixture/shared");
    await page.getByRole("textbox", { name: "初始分支", exact: true }).fill("develop");
    await control("nested");
    await next();
    assert.equal(await page.getByTestId("git-import-confirm").isDisabled(), true);
    await page.getByTestId("git-repository-back").click();
    await page.getByRole("checkbox", { name: "明确允许在已有仓库内创建嵌套仓库" }).check();
    await next();
    await control("hold");
    await page.getByTestId("git-import-confirm").evaluate((node) => {
      node.click();
      node.click();
    });
    await page.waitForFunction(() =>
      globalThis.__gitWorkspace.calls.some((c) => c.method === "acquireRepository"),
    );
    await page.keyboard.press("Escape");
    assert.equal(await page.getByTestId("git-repository-wizard").isVisible(), true);
    await control("release");
    await dialog().waitFor();
    assert.equal(await dialog().locator("[data-project-member]").count(), 1);
    assert.equal((await writes()).length, 1);
    assert.equal((await writes())[0].params.options.initialBranch, "develop");
    assert.equal((await writes())[0].params.options.allowNested, true);
    assert.equal((await control("registrationRequests")).length, 0);
  });
  await t.test("丢失回执只查询后追加，旧成功收据不冒充下一次创建", async () => {
    await open();
    await wizard();
    await location();
    await page
      .getByRole("textbox", { name: "仓库地址", exact: true })
      .fill("https://example.invalid/repo.git");
    await page.getByRole("textbox", { name: "新目录名称", exact: true }).fill("recovered");
    await next();
    await control("lostAck");
    await page.getByTestId("git-import-confirm").click();
    await page.getByTestId("git-workspace-error").waitFor();
    await page.getByRole("button", { name: "查询原请求结果", exact: true }).click();
    await page.getByTestId("git-repository-attach").click();
    await dialog().waitFor();
    assert.equal(await dialog().locator("[data-project-member]").count(), 1);
    assert.equal((await writes()).length, 1);
    await wizard();
    await location();
    await page
      .getByRole("textbox", { name: "仓库地址", exact: true })
      .fill("https://example.invalid/repo.git");
    await page.getByRole("textbox", { name: "新目录名称", exact: true }).fill("second");
    await next();
    assert.equal(await page.getByTestId("git-repository-attach").count(), 0);
    await control("lostAck");
    await page.getByTestId("git-import-confirm").click();
    await page.getByTestId("git-workspace-error").waitFor();
    assert.equal(
      await page.getByTestId("git-repository-attach").count(),
      0,
      "上一仓库的成功收据不能被本次丢回执操作复用",
    );
    await page.getByRole("button", { name: "查询原请求结果", exact: true }).click();
    await page.getByTestId("git-repository-attach").click();
    await dialog().waitFor();
    assert.equal(await dialog().locator("[data-project-member]").count(), 2);
    assert.equal((await writes()).length, 2);
  });
  await t.test("目录达到上限时在 Git 写入前阻断，取消不保存项目", async () => {
    await open();
    await control(
      "selectProjectFolders",
      Array.from({ length: 20 }, (_, i) => `/fixture/folder-${i}`),
    );
    await dialog().getByTestId("create-project-add-folder").click();
    await wizard();
    await location();
    await page
      .getByRole("textbox", { name: "仓库地址", exact: true })
      .fill("https://example.invalid/repo.git");
    await page.getByRole("textbox", { name: "新目录名称", exact: true }).fill("over-limit");
    await next();
    assert.equal(await page.getByTestId("git-import-confirm").isDisabled(), true);
    await page.getByRole("alert").filter({ hasText: /20/ }).waitFor();
    await page.getByRole("button", { name: "返回项目", exact: true }).click();
    await dialog().getByRole("button", { name: "取消", exact: true }).click();
    assert.deepEqual(await writes(), []);
    assert.equal((await control("registrationRequests")).length, 0);
  });
  await t.test("390px 明暗和英文布局，单 Dialog 不溢出", async () => {
    await mkdir("artifacts/project-git-integration", { recursive: true });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const query of ["", "?dark", "?dark&english"]) {
      await open(query);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await wizard();
      await next();
      assert.equal(await page.getByRole("dialog").count(), 1);
      assert.ok(
        await page
          .getByTestId("git-repository-wizard")
          .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
      );
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({
        path: `artifacts/project-git-integration/wizard-${query.includes("english") ? "english" : query ? "dark" : "light"}.png`,
        animations: "disabled",
      });
      assert.deepEqual(await writes(), []);
    }
  });
  assert.deepEqual(errors, []);
});
