import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "remote task background refresh keeps populated and empty lists stable",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const empty of [false, true]) {
      const page = await browser.newPage({ viewport: { width: empty ? 390 : 1280, height: 900 } });
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(
        `http://127.0.0.1:${port}/test/fixtures/remote-workspace-status.html?hold-queries${empty ? "&empty&english&theme=zai-light" : ""}`,
      );
      const state = page.getByTestId("task-query-state");
      const timeline = page.getByTestId("timeline-status");
      const pending = () =>
        page.waitForFunction(() => globalThis.__remoteStatus.pendingQueries().length >= 3);
      const settled = () =>
        page.waitForFunction(
          () =>
            document.querySelector('[data-testid="task-query-state"]').dataset.loading === "false",
        );
      const hint = page.getByText(empty ? "Loading remote tasks..." : "正在加载远端任务...", {
        exact: true,
      });
      const emptyHint = timeline.getByText(empty ? "No tasks yet" : "暂无任务", { exact: true });
      await pending();
      assert.equal(await state.getAttribute("data-loading"), "true");
      assert.equal(await state.getAttribute("data-syncing-remote"), "true");
      await page.evaluate(() =>
        globalThis.__remoteStatus.settleQueries(undefined, "Fixture initial failure"),
      );
      await settled();
      await page.evaluate(() => globalThis.__remoteStatus.setActivity("ssh", "running"));
      await pending();
      assert.equal(await state.getAttribute("data-loading"), "true");
      await page.evaluate(() => globalThis.__remoteStatus.settleQueries());
      await settled();
      assert.equal(await state.getAttribute("data-count"), empty ? "0" : "4");
      if (empty) await emptyHint.waitFor();
      else await timeline.getByText("ssh task", { exact: true }).waitFor();

      for (const kind of ["ssh", "wsl", "docker"]) {
        await page.evaluate((kind) => globalThis.__remoteStatus.setActivity(kind, "running"), kind);
        await pending();
        assert.equal(await state.getAttribute("data-loading"), "false");
        assert.equal(await state.getAttribute("data-syncing-remote"), "false");
        assert.equal(await hint.count(), 0);
        if (empty) assert.equal(await emptyHint.count(), 1);
        else assert.equal(await timeline.getByText("ssh task", { exact: true }).count(), 1);
        assert.equal(
          await page
            .getByTestId("project-status")
            .locator('[data-remote-connection-state="connected"]')
            .count(),
          1,
        );
        await page.evaluate(() => globalThis.__remoteStatus.settleQueries());
      }

      // 后台失败不应清空可信结果，下一次重读也不能把已有空态变回首次加载。
      await page.evaluate(() => globalThis.__remoteStatus.setActivity("ssh", "running"));
      await pending();
      await page.evaluate(() =>
        globalThis.__remoteStatus.settleQueries(undefined, "Fixture list failure"),
      );
      await page.evaluate(() => globalThis.__remoteStatus.setActivity("ssh", "completedSuccess"));
      await pending();
      assert.equal(await state.getAttribute("data-loading"), "false");
      assert.equal(await hint.count(), 0);
      await page.evaluate(() => globalThis.__remoteStatus.settleQueries());
      if (empty) await emptyHint.waitFor();
      else await timeline.locator('[data-task-execution-state="completed"]').waitFor();

      // 旧查询的成功标记不能跨查询条件、远程 session 或 Controller owner 复用。
      for (const change of ["change-query", "replace-session", "replace-controller"]) {
        if (change === "replace-controller")
          await page.evaluate(() => globalThis.__remoteStatus.replaceController());
        else await page.getByTestId(change).click();
        await pending();
        assert.equal(await state.getAttribute("data-loading"), "true");
        const oldRequests = await page.evaluate(() => globalThis.__remoteStatus.pendingQueries());
        await page.evaluate(() => globalThis.__remoteStatus.setActivity("ssh", "running"));
        await page.waitForFunction(
          (count) => globalThis.__remoteStatus.pendingQueries().length > count,
          oldRequests.length,
        );
        await page.evaluate((ids) => globalThis.__remoteStatus.settleQueries(ids), oldRequests);
        assert.equal(await state.getAttribute("data-loading"), "true");
        await page.evaluate(() => globalThis.__remoteStatus.settleQueries());
        await settled();
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  },
);

test(
  "SSH, WSL and Docker share live Controller task status and visible connection state",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const english of [false, true]) {
      const page = await browser.newPage({
        viewport: { width: english ? 1280 : 390, height: 900 },
      });
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(
        `http://127.0.0.1:${port}/test/fixtures/remote-workspace-status.html?${english ? "english&theme=zai-light" : ""}`,
      );
      const project = page.getByTestId("project-status");
      const timeline = page.getByTestId("timeline-status");
      const pinned = page.getByTestId("pinned-status");
      for (const kind of ["ssh", "wsl", "docker"]) {
        await page.getByTestId(`kind-${kind}`).click();
        await project.locator('[data-remote-connection-state="connected"]').waitFor();
        assert.match(
          await project.locator("[data-remote-connection-state]").innerText(),
          /已连接|Connected/,
        );
        const row = timeline
          .getByText(`${kind} task`, { exact: true })
          .locator("xpath=ancestor::li[1]");
        const pin = pinned
          .getByText(`${kind} pinned`, { exact: true })
          .locator("xpath=ancestor::li[1]");
        await row.locator('[data-task-execution-state="running"]').waitFor();
        await pin.locator('[data-task-execution-state="running"]').waitFor();
        for (const [phase, background, state] of [
          ["prewarming", false, "preparing"],
          ["running", false, "running"],
          ["completedSuccess", true, "background"],
          ["completedSuccess", false, "completed"],
          ["completedInterrupted", false, "interrupted"],
          ["error", false, "failed"],
        ]) {
          await page.evaluate(
            ({ kind, phase, background }) =>
              globalThis.__remoteStatus.setActivity(kind, phase, background),
            { kind, phase, background },
          );
          await row.locator(`[data-task-execution-state="${state}"]`).waitFor();
          await pin.locator(`[data-task-execution-state="${state}"]`).waitFor();
          await project.locator(`[data-task-execution-state="${state}"]`).waitFor();
        }
        await page.evaluate(
          (kind) => globalThis.__remoteStatus.setActivity(kind, "running", false, true),
          kind,
        );
        await row.getByText(english ? "Awaiting approval" : "等待确认", { exact: true }).waitFor();
        assert.equal(await row.locator("[data-task-execution-state]").count(), 0);
        await page.evaluate((kind) => globalThis.__remoteStatus.setOffline(kind, true), kind);
        await row.locator('[data-task-execution-state="offline"]').waitFor();
        assert.equal(await row.locator("svg.animate-spin").count(), 0);
        assert.equal(
          await row.getByText(english ? "Awaiting approval" : "等待确认", { exact: true }).count(),
          0,
        );
        await page.evaluate((kind) => {
          globalThis.__remoteStatus.setOffline(kind, false);
          globalThis.__remoteStatus.setActivity(kind, "running");
        }, kind);
        await row.locator('[data-task-execution-state="running"]').waitFor();
        for (const state of ["connecting", "failed", "idle", "connected"]) {
          await page.getByTestId(`connection-${state}`).click();
          await project.locator(`[data-remote-connection-state="${state}"]`).waitFor();
          if (state === "connecting") {
            await project.locator("[data-remote-connection-state]").hover();
            await page.getByRole("tooltip").getByText("Fixture deploying runtime 50%").waitFor();
          } else if (state === "failed") {
            await project
              .getByRole("button", { name: english ? "Reconnect" : "重新连接", exact: true })
              .click();
            await project.locator('[data-remote-connection-state="connecting"]').waitFor();
          }
        }
      }
      const queries = await page.evaluate(() => globalThis.__remoteStatus.queries);
      for (const kind of ["timeline", "pinned"]) {
        assert.ok(
          queries.some((query) => query.kind === kind && query.workspaceScopes.length === 4),
          "Controller must receive local and all remote scopes",
        );
      }
      assert.equal(await timeline.getByText("local task", { exact: true }).count(), 1);
      assert.equal(await timeline.locator('[data-task-execution-state="running"]').count(), 3);
      await page.evaluate(() =>
        globalThis.__remoteStatus.setActivity("docker", "completedSuccess"),
      );
      await timeline.locator('[data-task-execution-state="completed"]').waitFor();
      assert.deepEqual(errors, []);
      await mkdir(".artifacts/remote-workspace-status", { recursive: true });
      await page.screenshot({
        path: `.artifacts/remote-workspace-status/${english ? "desktop-en-light" : "mobile-zh-dark"}.png`,
        fullPage: true,
      });
      await page.close();
    }
  },
);

test(
  "collapsed remote project retains its completed unread indicator",
  { timeout: 60000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html`);
    const project = page
      .locator("[data-sidebar-entry]")
      .filter({ has: page.getByText("远程服务", { exact: true }) })
      .first();
    await project.getByText("远程项目会话", { exact: true }).waitFor();
    await page.evaluate(() => globalThis.__sidebarOrganization.markRemoteUnread());
    await project.locator('[data-unread-indicator="true"]').waitFor();
    await project.getByRole("button", { name: "远程服务", exact: true }).click();
    await project.locator('[data-workspace-unread-indicator="true"]').waitFor();
  },
);
