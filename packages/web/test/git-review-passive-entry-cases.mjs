import assert from "node:assert/strict";

export async function runGitReviewPassiveEntryCases(t, { page, url }) {
  const fixture = (method, ...args) =>
    page.evaluate(({ method, args }) => globalThis.__gitCommitFixture[method](...args), {
      method,
      args,
    });
  const pane = page.getByTestId("git-commit-review-pane");
  const input = page.getByTestId("git-commit-message-input");
  await t.test("安装版：干净仓库进入远端后产生任务改动，自动审核确认可实际提交", async () => {
    await page.goto(url);
    await fixture("dirty", []);
    await page.waitForFunction(() => globalThis.__gitCommitFixture.navigationReady());
    await fixture("openNetwork");
    await page.waitForFunction(
      () => document.querySelector('[data-testid="git-publish-toggle"]')?.disabled === false,
    );
    await fixture("dirty", ["a.ts"]);
    await fixture("automatic");
    await page.getByTestId("git-review-acknowledge").check();
    assert.equal(await page.getByTestId("git-commit-include-unstaged").isChecked(), true);
    await page.getByTestId("git-commit-action-item-commit").click();
    await pane.waitFor({ state: "hidden" });
    const commits = await page.evaluate(() =>
      globalThis.__gitCommitFixture.publish.calls.filter((call) => call.method === "commit"),
    );
    assert.equal(commits.length, 1);
    assert.ok(commits[0].params.review?.id);
  });
  await t.test("真实状态面板：运行期间已编辑的远端发布配置不被完成态自动草稿覆盖", async () => {
    await page.goto(`${url}?panel`);
    await fixture("dirty", []);
    await page.waitForFunction(() => globalThis.__gitCommitFixture.navigationReady());
    await fixture("openNetwork");
    await page.getByTestId("git-publish-toggle").click();
    await page.getByTestId("git-publish-branch-enabled").check();
    await page.getByTestId("git-publish-remote-origin").check();
    await fixture("gitSummaryAvailable", false);
    await page.getByTestId("git-summary-ready").filter({ hasText: "false" }).waitFor();
    assert.equal(await page.getByTestId("git-publish-branch-enabled").isChecked(), true);
    assert.equal(await page.getByTestId("git-publish-preview").isDisabled(), true);
    await fixture("dirty", ["a.ts"]);
    await fixture("gitSummaryAvailable", true);
    await page.getByTestId("git-summary-ready").filter({ hasText: "true" }).waitFor();
    await fixture("automatic");
    assert.equal(await pane.isVisible(), false);
    assert.equal(await page.getByTestId("git-publish-branch-enabled").isChecked(), true);
    assert.equal(await page.getByTestId("git-publish-remote-origin").isChecked(), true);
    await page.getByTestId("git-view-review").click();
    await page.getByTestId("git-review-include-a.ts").waitFor();
    assert.equal(await page.getByTestId("git-commit-include-unstaged").isChecked(), true);
    await page.getByTestId("git-view-network").click();
    assert.equal(await page.getByTestId("git-publish-branch-enabled").isChecked(), true);
  });
  await t.test("人工取消包含未暂存范围后，后续自动草稿不覆盖人工选择", async () => {
    await page.goto(url);
    await page.getByTestId("git-action-trigger").click();
    await input.waitFor();
    await page.getByTestId("git-commit-include-unstaged").uncheck();
    await fixture("automatic");
    assert.equal(await page.getByTestId("git-commit-include-unstaged").isChecked(), false);
    assert.equal(await page.getByTestId("git-commit-action-item-commit").isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => globalThis.__gitCommitFixture.publish.calls), []);
  });
  await t.test("仅生成草稿模式下远端初始化只读，手动进入审核时才采用冻结草稿", async () => {
    await page.goto(`${url}?reviewMode=draft`);
    await page.waitForFunction(
      () => document.querySelector('[data-testid="review-mode"]')?.textContent === "draft",
    );
    await page.waitForFunction(() => globalThis.__gitCommitFixture.navigationReady());
    await fixture("automatic");
    await fixture("openNetwork");
    await page.waitForFunction(
      () => document.querySelector('[data-testid="git-publish-toggle"]')?.disabled === false,
    );
    assert.equal((await fixture("readReviewWorkspace")).data.draft.message, "");
    assert.equal(await pane.isVisible(), false);
    await page.getByTestId("git-view-review").click();
    await page.getByTestId("git-review-acknowledge").waitFor();
    assert.equal(await input.inputValue(), "自动生成的中文提交纪要");
  });
  await t.test("自动草稿与远端注册同轮到达，远端只读初始化不抢先消费草稿", async () => {
    await page.goto(url);
    await page.waitForFunction(() => globalThis.__gitCommitFixture.navigationReady());
    await page.evaluate(() => {
      globalThis.__gitCommitFixture.automatic();
      globalThis.__gitCommitFixture.openNetwork();
    });
    await input.waitFor({ timeout: 4000 });
    await page.getByTestId("git-review-acknowledge").waitFor();
    assert.equal(await input.inputValue(), "自动生成的中文提交纪要");
  });
  for (const pending of [false, true]) {
    await t.test(
      `远端被动初始化${pending ? "尚未结束" : "完成"}后，自动草稿直接进入同一审核`,
      async () => {
        await page.goto(url);
        await page.waitForFunction(() => globalThis.__gitCommitFixture.navigationReady());
        if (pending) await fixture("holdNextReviewLoad");
        await fixture("openNetwork");
        const publication = page.getByTestId("git-network-publication-host");
        await publication.getByTestId("git-publish-toggle").waitFor();
        if (pending)
          await page.waitForFunction(() => globalThis.__gitCommitFixture.reviewLoadPending());
        else
          await page.waitForFunction(
            () => !document.querySelector('[data-testid="git-publish-toggle"]')?.disabled,
          );
        const composer = page.getByTestId("composer-draft");
        await composer.focus();
        await fixture("automatic");
        try {
          await input.waitFor({ timeout: 4000 });
          await page.waitForFunction(
            () =>
              document.querySelector('[data-testid="git-commit-message-input"]')?.value ===
              "自动生成的中文提交纪要",
          );
        } finally {
          if (pending) await fixture("releaseReviewLoad");
        }
        await page.getByTestId("git-review-acknowledge").waitFor();
        assert.equal(
          await page.getByTestId("git-view-review").getAttribute("aria-current"),
          "page",
        );
        assert.equal(await composer.evaluate((el) => el === document.activeElement), true);
        assert.deepEqual(await page.evaluate(() => globalThis.__gitCommitFixture.calls), []);
        assert.deepEqual(
          await page.evaluate(() => globalThis.__gitCommitFixture.publish.calls),
          [],
        );
        await input.fill("fix: 人工保留");
        await fixture("automatic");
        assert.equal(await input.inputValue(), "fix: 人工保留");
      },
    );
  }
  await t.test("远端显式生成进入审核；人工接管的发布选项与计划不被自动草稿覆盖", async () => {
    await page.goto(url);
    await page.waitForFunction(() => globalThis.__gitCommitFixture.navigationReady());
    await fixture("openNetwork");
    // 独立 fixture 的顶部按钮靠近面板覆盖区，用真实键盘激活，不强制穿透点击。
    await page.getByTestId("v4-composer-commit-summary").focus();
    await page.getByTestId("v4-composer-commit-summary").press("Enter");
    await page.getByTestId("git-review-acknowledge").waitFor();
    assert.equal((await page.evaluate(() => globalThis.__gitCommitFixture.calls)).length, 1);
    await page.goto(url);
    await page.waitForFunction(() => globalThis.__gitCommitFixture.navigationReady());
    await fixture("openNetwork");
    await page.getByTestId("git-publish-toggle").click();
    await page.getByTestId("git-publish-branch-enabled").check();
    await page.getByTestId("git-publish-remote-origin").check();
    await fixture("automatic");
    assert.equal(await pane.isVisible(), false);
    assert.equal(await page.getByTestId("git-publish-branch-enabled").isChecked(), true);
    await page.getByTestId("git-publish-preview").click();
    await page.getByTestId("git-publish-summary").waitFor();
    await fixture("automatic");
    assert.equal(await page.getByTestId("git-publish-summary").isVisible(), true);
    assert.equal(await pane.isVisible(), false);
    assert.deepEqual(await page.evaluate(() => globalThis.__gitCommitFixture.publish.calls), []);
  });
}
