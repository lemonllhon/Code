import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test("Git 变更页后台刷新保持布局与 Diff，聚焦和读取收敛", { timeout: 120_000 }, async (t) => {
  const { browser, port } = await startWorkflowProgressBrowser(t);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10_000);
  t.after(() => page.close());
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const api = (name, value) =>
    page.evaluate(([name, value]) => globalThis.__gitFiles[name](value), [name, value]);
  const metrics = () => api("metrics");
  const go = async (query = "") => {
    await page.goto(
      `http://127.0.0.1:${port}/test/fixtures/git-file-operations.html?live${query}`,
      { waitUntil: "domcontentloaded" },
    );
    await page.getByTestId("git-file-stage-all").waitFor();
    await page.waitForFunction(() => !globalThis.__gitFiles.metrics().loading);
  };
  const waitRefresh = async (revision) =>
    page.waitForFunction((revision) => {
      const m = globalThis.__gitFiles.metrics();
      return !m.loading && m.revision > revision;
    }, revision);

  await t.test("读取期间操作控件 DOM 和坐标保持，禁用执行且不闪暗", async () => {
    for (const config of [
      { width: 1280, query: "" },
      { width: 390, query: "&english&dark" },
    ]) {
      await page.setViewportSize({ width: config.width, height: 900 });
      await go(config.query);
      const row = page.getByRole("button", { name: /中文 file.ts/ });
      const button = await page.getByTestId("git-file-stage").first().elementHandle();
      const original = await row.boundingBox();
      const opacity = await button.evaluate((el) => getComputedStyle(el).opacity);
      await api("holdRefresh");
      await api("refresh");
      await page.waitForFunction(() => globalThis.__gitFiles.metrics().loading);
      assert.equal(
        await button.evaluate((el) => el.isConnected),
        true,
        "refresh must not unmount actions",
      );
      assert.deepEqual(await row.boundingBox(), original, "stats and chevron must not shift");
      assert.equal(await button.isDisabled(), true);
      assert.equal(await button.evaluate((el) => getComputedStyle(el).opacity), opacity);
      await button.evaluate((el) => el.click());
      assert.equal(
        await page.evaluate(() => globalThis.__gitFiles.calls.length),
        0,
        "refresh cannot admit writes",
      );
      assert.equal(await page.locator(".animate-spin").count(), 0, "automatic reads stay quiet");
      await api("releaseRefresh");
      await page.waitForFunction(() => !globalThis.__gitFiles.metrics().loading);
      assert.equal(await button.isEnabled(), true);
      assert.deepEqual(await row.boundingBox(), original);
    }
  });

  await t.test(
    "已展开 Diff 在重新核对期间保持内容与高度，慢请求串行追上最新 revision",
    async () => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await go();
      const row = page.getByRole("button", { name: /中文 file.ts/ });
      await row.click();
      await page.waitForFunction(
        () =>
          globalThis.__gitFiles.metrics().diffCount === 1 &&
          globalThis.__gitFiles.metrics().diffing === 0,
      );
      const preview = page.locator("diffs-container").first();
      await preview.waitFor();
      const element = await preview.elementHandle();
      const original = await preview.boundingBox();
      await api("holdDiff");
      let revision = (await metrics()).revision;
      await api("refresh");
      await waitRefresh(revision);
      await page.waitForFunction(() => globalThis.__gitFiles.metrics().diffing === 1);
      assert.equal(
        await element.evaluate((el) => el.isConnected),
        true,
        "old Diff must remain mounted",
      );
      assert.deepEqual(
        await preview.boundingBox(),
        original,
        "refresh must not collapse the preview",
      );
      assert.equal(await page.getByText("加载中...", { exact: true }).count(), 0);
      for (let i = 0; i < 3; i++) {
        revision = (await metrics()).revision;
        await api("refresh");
        await waitRefresh(revision);
      }
      assert.equal((await metrics()).diffCount, 2, "revisions do not create parallel Diff reads");
      await api("releaseDiff");
      await page.waitForFunction(
        () =>
          globalThis.__gitFiles.metrics().diffCount === 3 &&
          globalThis.__gitFiles.metrics().diffing === 0,
      );
      assert.equal((await metrics()).maxDiffing, 1);
      assert.equal(await element.evaluate((el) => el.isConnected), true);
      assert.deepEqual(await preview.boundingBox(), original);
      await api("editDiff", "changed with same line counts");
      revision = (await metrics()).revision;
      await api("refresh");
      await waitRefresh(revision);
      await page.getByText("changed with same line counts", { exact: true }).waitFor();
      await api("failDiff", true);
      revision = (await metrics()).revision;
      await api("refresh");
      await waitRefresh(revision);
      await page.getByText("fixture diff failed", { exact: true }).waitFor();
      await api("failDiff", false);
      await api("refresh");
      await page.getByText("changed with same line counts", { exact: true }).waitFor();
    },
  );

  await t.test("Linux 聚焦只触发一次读取；Windows/macOS 静止时读取与监听收敛", async () => {
    for (const os of ["linux", "win32", "darwin"]) {
      await go(`&os=${os}`);
      await page.waitForFunction(
        (count) => globalThis.__gitFiles.metrics().watchers === count,
        os === "linux" ? 1 : 2,
      );
      const before = await metrics();
      const row = page.getByRole("button", { name: /中文 file.ts/ });
      await row.click();
      const preview = page.locator("diffs-container").first();
      await preview.waitFor();
      const element = await preview.elementHandle();
      const original = await preview.boundingBox();
      await api("holdRefresh");
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.waitForFunction(() => globalThis.__gitFiles.metrics().loading);
      await api("releaseRefresh");
      await waitRefresh(before.revision);
      const after = await metrics();
      assert.equal(after.refreshCount - before.refreshCount, 1, "one focus produces one read");
      assert.equal(after.maxRefreshing, 1);
      // 使用有界观察窗口检查静止时收敛及 Linux 的既有 2s 可见轮询。
      await page.waitForTimeout(os === "linux" ? 2250 : 750);
      const settled = await metrics();
      assert.equal(settled.refreshCount, after.refreshCount + (os === "linux" ? 1 : 0));
      assert.equal(settled.watcherCount, after.watcherCount);
      assert.equal(await element.evaluate((el) => el.isConnected), true);
      assert.deepEqual(await preview.boundingBox(), original);
      assert.equal(await page.locator(".animate-spin").count(), 0);
    }
    assert.deepEqual(errors, []);
  });

  await t.test("手动刷新有反馈；已有空列表的后台读取不切换为空白加载页", async () => {
    await go();
    await api("holdRefresh");
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page.waitForFunction(() => globalThis.__gitFiles.metrics().loading);
    assert.equal(await page.locator(".animate-spin").count(), 1);
    await api("releaseRefresh");
    await page.waitForFunction(() => !globalThis.__gitFiles.metrics().loading);
    await page.getByTestId("git-file-stage-all").click();
    const empty = page.getByText("当前没有未暂存的改动", { exact: true });
    await empty.waitFor();
    const element = await empty.elementHandle();
    const original = await empty.boundingBox();
    await api("holdRefresh");
    await api("refresh");
    await page.waitForFunction(() => globalThis.__gitFiles.metrics().loading);
    assert.equal(await element.evaluate((el) => el.isConnected), true);
    assert.equal(await empty.innerText(), "当前没有未暂存的改动");
    assert.deepEqual(await empty.boundingBox(), original);
    assert.equal(await page.locator(".animate-spin").count(), 0);
    await api("releaseRefresh");
  });

  await t.test("同路径切远端 Host 后旧 Diff 不可见，迟到响应不能覆盖新内容", async () => {
    await go();
    await api("editDiff", "old Host content");
    await api("holdDiff");
    await page.getByRole("button", { name: /中文 file.ts/ }).click();
    await page.waitForFunction(() => globalThis.__gitFiles.metrics().diffing === 1);
    await api("unholdDiff");
    await api("editDiff", "new Host content");
    await api("remote");
    await page.waitForFunction(() => !globalThis.__gitFiles.metrics().loading);
    const row = page.getByRole("button", { name: /中文 file.ts/ });
    await row.waitFor();
    if ((await row.getAttribute("aria-expanded")) === "false") await row.click();
    await page.getByText("new Host content", { exact: true }).waitFor();
    await api("releaseDiff");
    await page.waitForFunction(() => globalThis.__gitFiles.metrics().diffing === 0);
    assert.equal(await page.getByText("old Host content", { exact: true }).count(), 0);
    await page.getByText("new Host content", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  });

  await t.test("文件内容查找后的用户滚动不被相同快照重新拉回命中行", async () => {
    await go("&many");
    await api("search", "after");
    await page.waitForFunction(
      () =>
        globalThis.__gitFiles.metrics().diffCount === 50 &&
        globalThis.__gitFiles.metrics().diffing === 0,
    );
    const scroll = page
      .locator("section [data-git-pane-change-virtual-row]")
      .first()
      .locator("../..");
    await scroll.evaluate((element) => {
      element.scrollTop = 180;
      element.dispatchEvent(new Event("scroll"));
    });
    const original = await scroll.evaluate((element) => element.scrollTop);
    assert.ok(original > 0, "fixture must have actual scrollable files");
    const revision = (await metrics()).revision;
    await api("refresh");
    await waitRefresh(revision);
    await page.waitForFunction(
      () =>
        globalThis.__gitFiles.metrics().diffCount === 100 &&
        globalThis.__gitFiles.metrics().diffing === 0,
    );
    assert.equal(await scroll.evaluate((element) => element.scrollTop), original);
    await api("search", "before");
    await page.waitForFunction(() => {
      const row = document.querySelector("[data-git-pane-change-virtual-row]");
      return row?.parentElement.parentElement.scrollTop === 0;
    });
  });
});
