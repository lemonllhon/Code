import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "sidebar removal persists for implicit, saved, dependent and offline projects and re-add keeps history",
  { timeout: 240000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const variant of ["implicit-project&project-lifecycle", "", "sets", "remote"]) {
      const page = await browser.newPage({
        viewport: { width: variant === "remote" ? 390 : 1280, height: 1000 },
      });
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(
        `http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html?saved-history&project-navigation&${variant}`,
      );
      const remote = variant === "remote";
      const row = page
        .getByTestId("unified-sidebar-tree")
        .getByText(remote ? "保存的远程项目" : "网站项目", { exact: true });
      await row.waitFor();
      if (variant === "") {
        await page.getByText("本地项目会话", { exact: true }).click({ button: "right" });
        await page.getByRole("menuitem", { name: "新建分区并移入…", exact: true }).click();
        const dialog = page.getByTestId("sidebar-organization-dialog");
        await dialog.getByLabel("分区名称", { exact: true }).fill("保留独立会话");
        await dialog.getByRole("button", { name: "确定", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
      }
      const before = await page.evaluate(() => ({
        tasks: globalThis.__sidebarOrganization.projectTaskSnapshot(),
        organization: globalThis.__sidebarOrganization.snapshot(),
      }));
      // 来源错误和依赖都不能沿用永久删除门禁阻止“只移除侧栏”。
      if (variant === "")
        await page.evaluate(() =>
          globalThis.__sidebarOrganization.setReadError(false, "Fixture unavailable"),
        );
      if (variant === "") {
        await page.evaluate(() => globalThis.__sidebarOrganization.rejectHistorySave(true));
        await row.click({ button: "right" });
        await page.getByRole("menuitem", { name: "从侧边栏移除", exact: true }).click();
        await page.getByText("项目操作失败，请刷新后重试。", { exact: true }).waitFor();
        assert.equal(await row.isVisible(), true);
        await page.evaluate(() => globalThis.__sidebarOrganization.rejectHistorySave(false));
      }
      await row.click({ button: "right" });
      const remove = page.getByRole("menuitem", { name: "从侧边栏移除", exact: true });
      assert.equal(await remove.isEnabled(), true);
      await remove.click();
      await row.waitFor({ state: "hidden" });
      const hidden = await page.evaluate((remote) => {
        const fixture = globalThis.__sidebarOrganization;
        return {
          project: fixture
            .settings()
            .projectDefinitions.projects.find((p) => Boolean(p.workspaceIdentity) === remote),
          tasks: fixture.projectTaskSnapshot(),
          organization: fixture.snapshot(),
          calls: fixture.calls,
        };
      }, remote);
      assert.ok(hidden.project.sidebarHiddenAt);
      assert.equal(hidden.project.archivedAt, undefined);
      assert.deepEqual(hidden.tasks, before.tasks);
      assert.deepEqual(hidden.organization, before.organization);
      assert.equal(
        hidden.calls.some(
          (call) => call.method === "deleteWorkspaceTasks" || call.method === "deleteCredential",
        ),
        false,
      );
      if (!remote) {
        assert.equal(await page.getByText("本地项目会话", { exact: true }).count(), 0);
        assert.equal(await page.getByText("登录优化", { exact: true }).count(), 0);
        assert.equal(await page.getByText("置顶会话", { exact: true }).count(), 0);
      }
      await page.getByTestId("sidebar-archive-toggle").click();
      assert.equal(await page.getByTestId(`archived-project-${hidden.project.id}`).count(), 0);
      await page.reload();
      await page.getByTestId("unified-sidebar-tree").waitFor();
      assert.equal(await row.count(), 0);
      if (remote)
        await page.evaluate(() => globalThis.__sidebarOrganization.setReconnectResult("success"));
      if (variant === "sets") {
        await page.getByTestId("project-readd-picker").getByRole("button").last().click();
        await page.getByRole("menuitemcheckbox").filter({ hasText: hidden.project.name }).click();
      } else
        await page
          .getByRole("button", {
            name: remote
              ? "再次添加远程项目"
              : variant.includes("implicit")
                ? "再次打开本地目录"
                : "再次添加本地项目",
            exact: true,
          })
          .click();
      await row.waitFor();
      const restored = await page.evaluate(
        (id) =>
          globalThis.__sidebarOrganization
            .settings()
            .projectDefinitions.projects.find((p) => p.id === id),
        hidden.project.id,
      );
      assert.equal(restored.sidebarHiddenAt, undefined);
      assert.deepEqual(restored.members, hidden.project.members);
      assert.deepEqual(
        await page.evaluate(() => globalThis.__sidebarOrganization.snapshot().sections),
        hidden.organization.sections,
      );
      if (!remote) await page.getByText("本地项目会话", { exact: true }).waitFor();
      assert.deepEqual(errors, []);
      await page.close();
    }
  },
);

test(
  "closed remote connections delete only after successful reconnect and preserve data on failure",
  { timeout: 150000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(
      `http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html?saved-history&project-lifecycle`,
    );
    const row = page.getByText("保存的远程项目", { exact: true });
    await row.waitFor();
    await row.click({ button: "right" });
    assert.equal(
      await page.getByRole("menuitem", { name: "删除项目…", exact: true }).isEnabled(),
      true,
    );
    await page.getByRole("menuitem", { name: "删除项目…", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^取消/ })
      .click();
    assert.equal(await page.evaluate(() => globalThis.__sidebarOrganization.facts.connects), 0);
    await page.evaluate(() => globalThis.__sidebarOrganization.setReconnectResult("failure"));
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "删除项目…", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^永久删除/ })
      .click();
    await page
      .getByText(/Fixture connection refused/)
      .last()
      .waitFor();
    assert.equal(await row.isVisible(), true);
    assert.equal(
      await page.evaluate(() =>
        globalThis.__sidebarOrganization.calls.some((c) => c.method === "deleteWorkspaceTasks"),
      ),
      false,
    );
    await page.evaluate(() => globalThis.__sidebarOrganization.setReconnectResult("success"));
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "删除项目…", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^永久删除/ })
      .click();
    await row.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "另一台远程项目", exact: true }).waitFor();
    await page.getByRole("button", { name: "网站项目", exact: true }).waitFor();
    const result = await page.evaluate(() => ({
      calls: globalThis.__sidebarOrganization.calls,
      tasks: globalThis.__sidebarOrganization.projectTaskSnapshot(),
      identity: globalThis.__sidebarOrganization.identity,
    }));
    const cleanup = result.calls.find((c) => c.method === "deleteWorkspaceTasks");
    assert.equal(cleanup.params.workspaceIdentity, result.identity);
    assert.equal(
      result.tasks.some((task) => task.workspaceIdentity === result.identity),
      false,
    );
    assert.equal(
      result.tasks.some((task) => task.taskId === "local"),
      true,
    );
    assert.ok(
      result.calls.findIndex((c) => c.method === "connectRemote") < result.calls.indexOf(cleanup),
    );
    await page.reload();
    await page.getByRole("button", { name: "另一台远程项目", exact: true }).waitFor();
    assert.equal(await row.count(), 0);
  },
);

test(
  "archive switches to sidebar or a chosen focus with one click, keyboard or touch",
  { timeout: 150000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const width of [1280, 390]) {
      const page = await browser.newPage({
        viewport: { width, height: 1000 },
        isMobile: width === 390,
        hasTouch: width === 390,
      });
      page.setDefaultTimeout(10000);
      await page.goto(
        `http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html?project-lifecycle`,
      );
      const archive = page.getByTestId("sidebar-archive-toggle");
      const sidebar = page.getByTestId("sidebar-organize");
      await archive.click();
      await page.getByTestId("sidebar-archive-panel").waitFor();
      if (width === 390) await sidebar.tap();
      else {
        await sidebar.focus();
        await page.keyboard.press("Enter");
      }
      await page.getByTestId("sidebar-archive-panel").waitFor({ state: "hidden" });
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "网站项目", exact: true }).waitFor();
      // 悬停菜单后选择当前已选 focus，也必须退出归档面板。
      if (width === 1280) {
        for (const label of ["全部", "项目", "会话", "工作树"]) {
          await archive.click();
          await sidebar.hover();
          await page.getByRole("menuitem", { name: "专注", exact: true }).hover();
          await page.getByRole("menuitemradio", { name: label, exact: true }).click();
          await page.getByTestId("sidebar-archive-panel").waitFor({ state: "hidden" });
        }
      }
      await page.close();
    }
  },
);
