import assert from "node:assert/strict";
import { openRemotePublication } from "./git-review-pane-helpers.mjs";

export async function runGitPublishRefreshCases(t, { page, url }) {
  page.setDefaultTimeout(12_000);
  const fixture = (method, ...args) =>
    page.evaluate(({ method, args }) => globalThis.__gitCommitFixture[method](...args), {
      method,
      args,
    });
  const control = (method, ...args) =>
    page.evaluate(({ method, args }) => globalThis.__gitCommitFixture.publish[method](...args), {
      method,
      args,
    });
  const input = page.getByTestId("git-commit-message-input");
  const calls = () => page.evaluate(() => globalThis.__gitCommitFixture.publish.calls);
  const check = async (id) => {
    const checkbox = page.getByTestId(id);
    if ((await checkbox.getAttribute("data-state")) !== "checked") await checkbox.click();
  };
  const setup = async (frozen = false, width = 1280) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.getByTestId("git-action-trigger").waitFor();
    if (frozen) {
      await fixture("automatic");
      await page.getByTestId("git-review-acknowledge").waitFor();
    } else await page.getByTestId("git-action-trigger").click();
    await input.fill("fix: 保留人工审核消息");
    if (frozen) await check("git-review-acknowledge");
    await openRemotePublication(page);
    await page.getByTestId("git-publish-toggle").click();
    await check("git-publish-remote-origin");
    await check("git-publish-branch-enabled");
    await page.getByTestId("git-publish-tag-mode").click();
    await page.getByTestId("git-publish-tag-mode-create-and-push").click();
    await page.getByTestId("git-publish-tag-name").fill("v-refresh-test");
    await page.getByTestId("git-publish-commit-preview").click();
    await page.getByTestId("git-publish-confirm").waitFor();
  };
  const ready = async () => {
    await page
      .getByTestId("git-publish-refresh-status")
      .filter({ hasText: "最新状态已更新" })
      .waitFor();
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="git-publish-new-plan"]')?.disabled,
    );
  };

  for (const frozen of [false, true]) {
    await t.test(
      `${frozen ? "冻结" : "普通"}过期审批自动刷新，保留结果与编辑但不重放或自动确认`,
      async () => {
        await setup(frozen);
        await fixture("dirty", ["a.ts", "new-after-preview.ts"]);
        await control("mutate", "worktreeFingerprint");
        await fixture("holdNextReviewLoad");
        const count = await fixture("reviewLoadCount");
        await page.getByTestId("git-publish-confirm").click();
        await page
          .getByTestId("git-publish-refresh-status")
          .filter({ hasText: "正在自动更新" })
          .waitFor({ timeout: 5000 });
        assert.equal(await fixture("reviewLoadPending"), true);
        assert.equal(await page.getByTestId("git-publish-new-plan").isDisabled(), true);
        assert.deepEqual(await calls(), []);
        await fixture("releaseReviewLoad");
        await ready();
        assert.equal(await fixture("reviewLoadCount"), count + 1);
        assert.match(await page.getByTestId("git-publish-results").innerText(), /仓库状态已变化/);
        await page.getByTestId("git-publish-new-plan").click();
        await input.waitFor({ state: "visible" });
        assert.equal(await input.inputValue(), "fix: 保留人工审核消息");
        assert.equal(await page.getByTestId("git-review-acknowledge").count(), 0);
        if (frozen)
          assert.equal(await page.getByTestId("git-commit-action-item-commit").isDisabled(), true);
        else await page.getByTestId("git-review-include-new-after-preview.ts").waitFor();
        await openRemotePublication(page);
        assert.equal(await page.getByTestId("git-publish-tag-name").inputValue(), "v-refresh-test");
        assert.equal(
          await page.getByTestId("git-publish-remote-origin").getAttribute("data-state"),
          "checked",
        );
        assert.deepEqual(await calls(), []);
      },
    );
  }

  for (const warning of [false, true]) {
    await t.test(
      `部分成功后的${warning ? "警告" : "真实变化"}自动刷新，保留成功事实且不执行 Tag`,
      async () => {
        await setup();
        await control("holdPush", "origin");
        await page.getByTestId("git-publish-confirm").click();
        try {
          await page.waitForFunction(
            () => globalThis.__gitCommitFixture.publish.calls.length >= 2,
            null,
            { timeout: 8000 },
          );
        } catch (error) {
          throw new Error(
            JSON.stringify({
              calls: await calls(),
              ui: await page.getByTestId("git-source-publication").innerText(),
            }),
            { cause: error },
          );
        }
        await fixture("dirty", ["after-commit.ts"]);
        if (warning) await control("warnPush", "fixture-push-warning");
        else await control("mutate", "worktreeFingerprint");
        await control("releasePush");
        await ready();
        assert.deepEqual(
          (await calls()).map((c) => c.method),
          ["commit", "push"],
        );
        assert.equal(
          await page.getByTestId("git-publish-result-commit").getAttribute("data-status"),
          "success",
        );
        assert.equal(
          await page.getByTestId("git-publish-result-branch-origin").getAttribute("data-status"),
          "success",
        );
        assert.equal(
          await page
            .getByTestId("git-publish-result-create-tag-v%2Drefresh%2Dtest")
            .getAttribute("data-status"),
          "skipped",
        );
        const count = await fixture("reviewLoadCount");
        await fixture("rerender");
        await page.getByTestId("git-publish-results-back").click();
        await page.getByTestId("git-publish-back").click();
        assert.equal(await fixture("reviewLoadCount"), count);
        await page.getByTestId("git-publish-new-plan").click();
        await input.waitFor({ state: "visible" });
        await page.getByTestId("git-review-include-after-commit.ts").waitFor();
        assert.equal(await input.inputValue(), "");
        assert.deepEqual(
          (await calls()).map((c) => c.method),
          ["commit", "push"],
        );
      },
    );
  }

  for (const catalog of [false, true]) {
    await t.test(
      `${catalog ? "目录" : "范围"}自动读取失败保留结果与编辑，只重试读取，390px 明暗布局`,
      async () => {
        await setup(false, 390);
        await control("mutate", "worktreeFingerprint");
        if (catalog) await control("failList");
        else await fixture("failLoad");
        await page.getByTestId("git-publish-confirm").click();
        await page
          .getByTestId("git-publish-refresh-status")
          .filter({ hasText: "自动更新失败" })
          .waitFor();
        const button = page.getByTestId("git-publish-new-plan");
        await page.waitForFunction(
          () => !document.querySelector('[data-testid="git-publish-new-plan"]')?.disabled,
        );
        assert.match(await button.innerText(), /重试读取/);
        assert.deepEqual(await calls(), []);
        for (const theme of ["theme-zai-light", "dark theme-zai-dark"]) {
          await page.setViewportSize({ width: 390, height: 844 });
          await page.evaluate((theme) => {
            document.documentElement.className = theme;
          }, theme);
          assert.ok(
            await page
              .getByTestId("git-publish-results")
              .evaluate((e) => e.scrollWidth - e.clientWidth <= 1),
          );
        }
        await page.screenshot({
          path: `artifacts/git-build-acceptance-pass5/screenshots/auto-refresh-${catalog ? "catalog" : "scope"}-failure.png`,
        });
        await button.click();
        await ready();
        assert.deepEqual(await calls(), []);
        await button.click();
        await input.waitFor({ state: "visible" });
        assert.equal(await input.inputValue(), "fix: 保留人工审核消息");
      },
    );
  }

  for (const switchKind of ["switchSession", "logEpoch"]) {
    await t.test(`自动刷新在途 ${switchKind}，迟到响应不覆盖新审核或重放`, async () => {
      await setup();
      await control("mutate", "worktreeFingerprint");
      await fixture("holdNextReviewLoad");
      await page.getByTestId("git-publish-confirm").click();
      await page
        .getByTestId("git-publish-refresh-status")
        .filter({ hasText: "正在自动更新" })
        .waitFor();
      await fixture(switchKind, "new-refresh-scope");
      await page
        .getByTestId("git-commit-review-pane")
        .filter({ visible: true })
        .waitFor({ state: "hidden" });
      await page.getByTestId("git-action-trigger").click();
      await input.fill("fix: 新会话消息");
      await fixture("releaseReviewLoad");
      await fixture("rerender");
      assert.equal(await input.inputValue(), "fix: 新会话消息");
      assert.equal(await page.getByTestId("git-publish-results").count(), 0);
      assert.deepEqual(await calls(), []);
    });
  }
}
