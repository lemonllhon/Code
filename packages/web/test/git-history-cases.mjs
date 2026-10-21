import { runGitHistoryAdvancedCases } from "./git-history-advanced-cases.mjs";
import { runGitHistoryInteractionCases } from "./git-history-interaction-cases.mjs";
import assert from "node:assert/strict";
import { runGitHistoryLayoutCases } from "./git-history-layout-cases.mjs";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
export async function runGitHistoryCases(t, { page, url }) {
  page.setDefaultTimeout(15000);
  const fixtureUrl = new URL("git-history.html", url).href;
  const artifactPath = (name = "") =>
    fileURLToPath(new URL(`../../../artifacts/git-history/${name}`, import.meta.url));
  const go = async (query = "") => {
    await page.goto(fixtureUrl + query);
    await page.getByTestId("git-view-graph").click();
    await page.getByTestId("git-history-commit").first().waitFor({ state: "visible" });
  };
  const control = (method) => page.evaluate((key) => globalThis.__gitHistory[key](), method);
  const writes = () =>
    page.evaluate(() =>
      globalThis.__gitHistory.calls.filter((call) =>
        [
          "startIntegration",
          "continueIntegration",
          "abortIntegration",
          "createHistoryTag",
          "resetHistory",
          "saveConflictResult",
          "markConflictResolved",
        ].includes(call.method),
      ),
    );
  const select = async () => {
    await page.getByTestId("git-history-commit").first().click();
    await page.getByTestId("git-history-detail").waitFor();
  };
  await t.test(
    "历史筛选是字面请求，详情/parent/真实 Diff 只读，合并提交禁用缺主线的操作",
    async () => {
      await go("?merge");
      await page.getByTestId("git-history-advanced-toggle").click();
      await page.getByRole("textbox", { name: "作者", exact: true }).fill("[Fixture]");
      await page.getByRole("textbox", { name: "消息或 Hash", exact: true }).fill("--all");
      await page.getByTestId("git-history-filter").click();
      await select();
      assert.match(await page.getByTestId("git-history-message").innerText(), /完整中文/);
      await page.getByRole("combobox", { name: "对比父提交" }).selectOption("2");
      await page.getByTestId("git-history-file").first().click();
      await page.getByTestId("git-history-diff").locator("diffs-container").waitFor();
      await page.waitForFunction(() =>
        document
          .querySelector('[data-testid="git-history-diff"] diffs-container')
          ?.shadowRoot?.querySelector("pre")
          ?.textContent.includes("parent two"),
      );
      assert.equal(await page.getByTestId("git-history-cherry-pick").isDisabled(), true);
      const queries = await page.evaluate(() =>
        globalThis.__gitHistory.calls.filter((call) => call.method === "history"),
      );
      assert.equal(queries.at(-1).params.author, "[Fixture]");
      assert.equal(queries.at(-1).params.search, "--all");
      assert.deepEqual(await writes(), []);
    },
  );
  await t.test("refs 变化使旧分页失效，刷新不拼接重复历史", async () => {
    await go();
    await control("externalChange");
    await page.getByTestId("git-history-more").click();
    assert.match(await page.getByTestId("git-workspace-error").innerText(), /引用已变化/);
    assert.equal(await page.getByTestId("git-history-commit").count(), 2);
    await page.getByRole("button", { name: "刷新历史", exact: true }).click();
    await page.getByTestId("git-history-more").click();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="git-history-commit"]').length === 3,
    );
    assert.deepEqual(await writes(), []);
  });
  for (const mode of ["cherry-pick", "revert"])
    await t.test(`${mode} 预览后转原整合 owner，人工解决再继续或中止`, async () => {
      await go();
      await select();
      await page.getByTestId(`git-history-${mode}`).click();
      await page.getByTestId("git-history-confirmation").waitFor();
      assert.deepEqual(await writes(), []);
      await page.getByTestId("git-history-confirm").click();
      await page.getByTestId("git-integration-active").waitFor();
      if (mode === "revert") {
        await page.getByTestId("git-integration-abort").click();
        assert.equal(await page.getByTestId("git-integration-confirm").isDisabled(), true);
        await page.getByTestId("git-integration-discard-check").check();
        await page.getByTestId("git-integration-confirm").click();
      } else {
        await page.getByTestId("git-integration-resolve").click();
        await page.getByTestId("git-conflict-result").fill("resolved history\n");
        await page.getByTestId("git-conflict-save").click();
        await page.getByTestId("git-conflict-confirm").click();
        await page.waitForFunction(
          () => document.querySelector('[data-testid="git-conflict-mark"]')?.disabled === false,
        );
        await page.getByTestId("git-conflict-mark").click();
        await page.getByTestId("git-conflict-confirm").click();
        await page.waitForFunction(
          () => !document.querySelector('[data-testid="git-conflict-result"]'),
        );
        await page.getByTestId("git-conflict-integration").click();
        await page.getByTestId("git-integration-continue").click();
        await page.getByTestId("git-integration-confirm").click();
      }
      await page.getByTestId("git-integration-start").waitFor();
      const mutations = await writes(),
        source = mutations[0].params.requestId;
      assert.equal(mutations[0].params.preview.mode, mode);
      assert.ok(mutations.slice(1).every((call) => call.params.sourceRequestId === source));
    });
  const tag = async () => {
    await select();
    await page.getByTestId("git-history-tag-open").click();
    await page.getByRole("textbox", { name: "Tag 名称", exact: true }).fill("v-fixture");
    await page.getByRole("textbox", { name: "Tag 注释", exact: true }).fill("fixture tag\n中文");
  };
  await t.test("附注/签名 Tag 独立确认，取消零写入；检查实际 Tag 不触发推送", async () => {
    await go();
    await tag();
    await page.getByTestId("git-history-tag-form").getByRole("checkbox").check();
    await page.getByTestId("git-history-tag-preview").click();
    assert.match(await page.getByTestId("git-history-confirmation").innerText(), /签名 Tag|ssh/);
    assert.deepEqual(await writes(), []);
    await page
      .getByTestId("git-history-confirmation")
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await page.getByTestId("git-history-tag-preview").click();
    await page.getByTestId("git-history-confirm").click();
    await page.getByTestId("git-history-tag-inspect").click();
    assert.match(await page.getByTestId("git-history-tag-info").innerText(), /包含签名/);
    assert.equal((await writes()).filter((call) => call.method === "createHistoryTag").length, 1);
  });
  await t.test("Tag 丢回执只查原请求与实际 ref，不重新创建", async () => {
    await go();
    await tag();
    await page.getByTestId("git-history-tag-preview").click();
    await control("lostAck");
    await page.getByTestId("git-history-confirm").click();
    assert.match(await page.getByTestId("git-workspace-error").innerText(), /未收到明确结果/);
    await page.getByRole("button", { name: "刷新历史", exact: true }).click();
    await page.getByTestId("git-history-tag-inspect").click();
    await page.getByTestId("git-history-tag-info").waitFor();
    assert.equal((await writes()).filter((call) => call.method === "createHistoryTag").length, 1);
  });
  await t.test("Host 切换丢弃迟到详情/旧确认，远端写入携带 identity", async () => {
    await go();
    await control("hold");
    await page.getByTestId("git-history-commit").first().click();
    await control("remote");
    await control("release");
    await page.waitForFunction(() =>
      globalThis.__gitHistory.calls.some(
        (call) => call.host === "remote" && call.method === "history",
      ),
    );
    assert.equal(await page.getByTestId("git-history-detail").count(), 0);
    await select();
    await page.getByTestId("git-history-cherry-pick").click();
    await page.getByTestId("git-history-confirm").click();
    await page.getByTestId("git-integration-active").waitFor();
    const mutation = (await writes())[0];
    assert.equal(mutation.host, "remote");
    assert.equal(mutation.params.workspaceIdentity, "fixture:remote");
  });
  await t.test("390px 中文亮色/英文暗色、二进制分流与宽屏图谱，字体和键盘可用", async () => {
    await mkdir(artifactPath(), { recursive: true });
    for (const english of [false, true]) {
      await page.setViewportSize({ width: 390, height: 844 });
      await go(english ? "?english&dark&binary" : "?binary");
      await select();
      assert.equal(await page.getByTestId("git-history-more").isVisible(), true);
      await page.getByTestId("git-history-advanced-toggle").click();
      const since = page.getByLabel(english ? "From date (UTC)" : "开始日期（UTC）", {
        exact: true,
      });
      const until = page.getByLabel(english ? "To date (UTC)" : "结束日期（UTC）", { exact: true });
      await since.fill("2026-10-01");
      await until.fill("2026-10-20");
      assert.equal(await since.getAttribute("max"), "2026-10-20");
      assert.equal(await until.getAttribute("min"), "2026-10-01");
      await page.getByTestId("git-history-file").first().click();
      await page.getByTestId("git-history-special").waitFor();
      assert.equal(await page.getByTestId("git-history-diff").count(), 0);
      assert.ok(
        await page
          .getByRole("textbox")
          .first()
          .evaluate((element) => parseFloat(getComputedStyle(element).fontSize) >= 16),
      );
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.getByTestId("git-history-cherry-pick").click();
      await page.getByTestId("git-history-confirmation").waitFor();
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute("data-testid")),
        "git-history-confirmation",
      );
      await page.screenshot({
        path: artifactPath(`${english ? "english-dark" : "chinese-light"}.png`),
      });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(fixtureUrl + "?wide");
    await page.getByTestId("git-view-graph").click();
    await page
      .getByRole("button")
      .filter({ hasText: "feat: 中文 history bbbb" })
      .filter({ visible: true })
      .first()
      .click();
    await page.getByTestId("git-history-detail").waitFor();
    assert.equal(await page.getByTestId("git-history-more").isVisible(), true);
    assert.equal(
      await page
        .getByText("feat: 中文 history bbbb", { exact: true })
        .filter({ visible: true })
        .count(),
      1,
    );
    assert.equal(await page.getByTestId("git-history-advanced").count(), 0);
    await page.screenshot({ path: artifactPath("desktop.png") });
  });
  await runGitHistoryAdvancedCases(t, { page, go, select, control, writes });
  await runGitHistoryInteractionCases(t, { page, go, select, control, writes });
  await runGitHistoryLayoutCases(t, { page, go, select, control, writes, artifactPath });
}
