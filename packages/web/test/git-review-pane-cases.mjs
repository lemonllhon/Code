import assert from "node:assert/strict";
import { runGitReviewPassiveEntryCases } from "./git-review-passive-entry-cases.mjs";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function runGitReviewPaneCases(t, { page, url }) {
  page.setDefaultTimeout(15000);
  const fixture = (method, ...args) =>
    page.evaluate(({ method, args }) => globalThis.__gitCommitFixture[method](...args), {
      method,
      args,
    });
  const pane = page.getByTestId("git-commit-review-pane");
  const input = page.getByTestId("git-commit-message-input");
  const ready = () => input.waitFor();
  await t.test("安装版回归：最终自动提交后手动重开读取新文件，不复用已完成冻结范围", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url);
    await fixture("automatic");
    await ready();
    await page.getByTestId("git-review-acknowledge").check();
    await page.getByTestId("git-commit-action-item-commit").click();
    await pane.waitFor({ state: "hidden" });
    await fixture("dirty", ["new-after-commit.ts"]);
    await page.getByTestId("git-action-trigger").click();
    await ready();
    await page.getByTestId("git-review-include-new-after-commit.ts").waitFor();
    assert.equal(await page.getByTestId("git-commit-include-unstaged").isChecked(), true);
    assert.equal(await page.getByTestId("git-review-acknowledge").count(), 0);
    assert.equal(await input.inputValue(), "");
    await input.fill("fix: 下一次手动提交");
    await page.getByTestId("git-review-side-pane").screenshot({
      path: fileURLToPath(
        new URL(
          "../../../artifacts/git-build-acceptance/screenshots/source-review-new-files.png",
          import.meta.url,
        ),
      ),
      animations: "disabled",
    });
    await page.getByTestId("git-commit-action-item-commit").click();
    await pane.waitFor({ state: "hidden" });
    const commits = await page.evaluate(() =>
      globalThis.__gitCommitFixture.publish.calls.filter((call) => call.method === "commit"),
    );
    assert.equal(commits.length, 2);
    assert.equal(commits[1].params.review, undefined);
    assert.deepEqual(commits[1].params.paths, ["new-after-commit.ts"]);
  });
  await t.test("自动内容审核不可用时，人工提交完成后也不复用已消费草稿路径", async () => {
    await page.goto(url);
    await fixture("automatic", true);
    await ready();
    await pane
      .getByRole("button", { name: "改用普通手动提交（当前所选整个文件）", exact: true })
      .click();
    await input.fill("chore: 人工确认");
    await page.getByTestId("git-commit-action-item-commit").click();
    await pane.waitFor({ state: "hidden" });
    await fixture("dirty", ["next-manual.ts"]);
    await page.getByTestId("git-action-trigger").click();
    await ready();
    await page.getByTestId("git-review-include-next-manual.ts").waitFor();
    assert.equal(await input.inputValue(), "");
  });
  await t.test("提交警告保留原范围和恢复关联，不按最终成功清理或解锁确认", async () => {
    await page.goto(url);
    await fixture("automatic");
    await ready();
    await page.evaluate(() =>
      globalThis.__gitCommitFixture.publish.warnCommit("fixture-commit-warning"),
    );
    await page.getByTestId("git-review-acknowledge").check();
    await page.getByTestId("git-commit-action-item-commit").click();
    await pane.getByRole("alert").filter({ hasText: "fixture-commit-warning" }).waitFor();
    await page.waitForFunction(
      async () =>
        (await globalThis.__gitCommitFixture.readReviewWorkspace()).data.draft.requiresRegeneration,
    );
    const shared = await fixture("readReviewWorkspace");
    assert.deepEqual(shared.data.selectedPaths, ["a.ts"]);
    assert.ok(shared.data.sourceReview?.id);
    assert.equal(await page.getByTestId("git-commit-action-item-commit").isDisabled(), true);
    await input.press("Control+Enter");
    assert.equal(
      (
        await page.evaluate(() =>
          globalThis.__gitCommitFixture.publish.calls.filter((call) => call.method === "commit"),
        )
      ).length,
      1,
    );
  });
  await t.test("发布统一归远端：审核无发布区，首次进入远端只读初始化且不生成草稿", async () => {
    await page.goto(url);
    await page.getByTestId("git-action-trigger").waitFor();
    await page.waitForFunction(() => globalThis.__gitCommitFixture.navigationReady());
    await fixture("openNetwork");
    const directPublication = page.getByTestId("git-network-publication-host");
    await directPublication.getByTestId("git-publish-toggle").waitFor();
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="git-publish-toggle"]')?.disabled,
    );
    assert.equal(await pane.isVisible(), false);
    await directPublication.getByRole("button", { name: "提交审核", exact: true }).click();
    await ready();
    assert.equal(await pane.isVisible(), true);
    assert.deepEqual(await page.evaluate(() => globalThis.__gitCommitFixture.calls), []);
    await page.goto(url);
    await page.getByTestId("git-action-trigger").click();
    await ready();
    assert.equal(await pane.getByTestId("git-publish-toggle").count(), 0);
    await page.getByTestId("git-view-network").click();
    const publication = page.getByTestId("git-network-publication-host");
    await publication.getByTestId("git-publish-toggle").waitFor();
    await publication.getByTestId("git-publish-toggle").click();
    await publication.getByTestId("git-publish-remote-origin").waitFor();
    await page.getByTestId("git-review-side-pane").screenshot({
      path: fileURLToPath(
        new URL(
          "../../../artifacts/git-build-acceptance/screenshots/source-remote-publication.png",
          import.meta.url,
        ),
      ),
      animations: "disabled",
    });
    await publication.getByTestId("git-publish-branch-enabled").check();
    await page.getByTestId("git-view-graph").click();
    await page.getByTestId("git-view-network").click();
    assert.equal(await publication.getByTestId("git-publish-branch-enabled").isChecked(), true);
    assert.deepEqual(await page.evaluate(() => globalThis.__gitCommitFixture.publish.calls), []);
    assert.deepEqual(await page.evaluate(() => globalThis.__gitCommitFixture.calls), []);
  });
  await runGitReviewPassiveEntryCases(t, { page, url });
  if (process.env.LCODE_GIT_REVIEW_TEST_CASES === "build-acceptance") return;
  await t.test("第2版：手动直接进入右侧文件/Diff/消息/固定动作，没有旧审核弹框", async () => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(url);
    await page.getByTestId("git-action-trigger").click();
    await ready();
    assert.equal(
      await page.getByTestId("git-review-pane-host").getByTestId("git-commit-review-pane").count(),
      1,
    );
    assert.equal(await page.getByTestId("git-commit-dialog").count(), 0);
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await page.getByTestId("git-review-empty").isVisible(), false);
    assert.equal(await page.getByTestId("git-scope-open-files").count(), 0);
    const files = await page.getByTestId("git-review-file-list").boundingBox();
    const diff = await page.getByTestId("git-review-inline-diff").boundingBox();
    const message = await input.boundingBox();
    const footer = await page.getByTestId("git-review-footer").boundingBox();
    assert.ok(files && diff && message && footer);
    assert.ok(files.x < diff.x && Math.abs(files.y - diff.y) < 2, JSON.stringify({ files, diff }));
    assert.ok(message.y >= files.y + files.height - 2);
    assert.ok(footer.y + footer.height <= 1080);
    assert.deepEqual(await page.evaluate(() => globalThis.__gitCommitFixture.publish.calls), []);
    const output = new URL("../../../artifacts/git-review-pane/", import.meta.url);
    await mkdir(output, { recursive: true });
    await page.screenshot({
      path: fileURLToPath(new URL("review-v2-desktop.png", output)),
      animations: "disabled",
    });
  });
  await t.test("自动审核进入同一右侧，保留输入焦点、冻结内容；重复事件不覆盖人工消息", async () => {
    await page.goto(url);
    const composer = page.getByTestId("composer-draft");
    await composer.focus();
    await fixture("automatic");
    await ready();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="git-commit-message-input"]')?.value ===
        "自动生成的中文提交纪要",
    );
    assert.equal(await composer.evaluate((el) => el === document.activeElement), true);
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.match(await page.getByTestId("git-review-diff-content").innerText(), /fixture/);
    assert.equal((await page.evaluate(() => globalThis.__gitCommitFixture.diffQueries)).length, 0);
    await input.fill("feat: 人工检查后的草稿");
    await fixture("automatic");
    assert.equal(await input.inputValue(), "feat: 人工检查后的草稿");
    await page.getByTestId("git-commit-close").click();
    await pane.waitFor({ state: "hidden" });
    await fixture("rerender");
    assert.equal(await pane.isVisible(), false);
    await page.getByTestId("git-action-trigger").click();
    await ready();
    assert.equal(await input.inputValue(), "feat: 人工检查后的草稿");
  });
  await t.test("同页范围勾选与预览独立；切变更子页再返回保留草稿和排除", async () => {
    await page.goto(url);
    await page.getByTestId("git-action-trigger").click();
    await ready();
    await input.fill("fix: 保留编辑");
    const include = page.getByTestId("git-review-include-a.ts").first();
    await include.uncheck();
    assert.equal(await include.isChecked(), false);
    await page.getByTestId("review-workspace-files").getByRole("button", { name: /a.ts/ }).click();
    assert.equal(await include.isChecked(), false);
    // 普通手动范围只同步所选文件，不能因为排除一项就要求先调用模型。
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="git-commit-action-item-commit"]')?.disabled === false,
    );
    assert.equal(await page.getByTestId("git-commit-action-item-commit").isDisabled(), false);
    assert.deepEqual(await page.evaluate(() => globalThis.__gitCommitFixture.publish.calls), []);
    await page.getByTestId("git-view-changes").click();
    await pane.waitFor({ state: "hidden" });
    await page.getByTestId("git-view-review").click();
    await ready();
    assert.equal(await input.inputValue(), "fix: 保留编辑");
    assert.equal(await include.isChecked(), false);
  });
  await t.test("目录三态与折叠：预览和纳入独立，批量只发送该目录路径", async () => {
    await page.goto(url);
    await fixture("dirty", ["src/a.ts", "src/b.ts", "docs/readme.md"]);
    await page.getByTestId("git-action-trigger").click();
    await ready();
    const folder = page.getByTestId("git-review-include-node-changes/src");
    await folder.uncheck();
    assert.equal(await page.getByTestId("git-review-include-src/a.ts").isChecked(), false);
    assert.equal(await page.getByTestId("git-review-include-docs/readme.md").isChecked(), true);
    await page.getByTestId("git-review-include-src/a.ts").check();
    assert.equal(await folder.getAttribute("data-state"), "indeterminate");
    await page.getByTestId("git-review-collapse-tree").click();
    assert.equal(await page.getByTestId("git-review-include-src/a.ts").isVisible(), false);
    await page.getByTestId("git-review-expand-tree").click();
    assert.equal(await page.getByTestId("git-review-include-src/a.ts").isChecked(), true);
    assert.deepEqual(await page.evaluate(() => globalThis.__gitCommitFixture.publish.calls), []);
  });
  await t.test("提交图复用当前执行作用域，返回审核保持消息，不打开弹框", async () => {
    await page.goto(url);
    await page.getByTestId("git-action-trigger").click();
    await ready();
    await input.fill("fix: graph navigation");
    await page.getByTestId("git-view-graph").click();
    await page.waitForFunction(() => globalThis.__gitCommitFixture.graphQueries.length > 0);
    const queries = await page.evaluate(() => globalThis.__gitCommitFixture.graphQueries);
    assert.ok(
      queries.every(
        (query) =>
          query.workspacePath === "/fixture/repo" &&
          query.workspaceIdentity === "fixture-host/repo",
      ),
    );
    assert.equal(await page.getByRole("dialog").count(), 0);
    await page.getByTestId("git-view-review").click();
    await ready();
    assert.equal(await input.inputValue(), "fix: graph navigation");
    assert.deepEqual(await page.evaluate(() => globalThis.__gitCommitFixture.publish.calls), []);
  });
  await t.test("390px 同一审核内容由既有 Drawer 展示，主操作可达", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url);
    await page.getByTestId("git-action-trigger").click();
    await ready();
    assert.equal(await page.getByTestId("git-commit-dialog").count(), 0);
    await page.getByTestId("git-review-show-diff").click();
    await page.getByTestId("git-review-inline-diff").waitFor();
    await page.getByTestId("git-review-show-files").click();
    const close = await page.getByTestId("git-commit-close").boundingBox();
    assert.ok(close && close.y + close.height <= 844);
    assert.ok(await pane.evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
    const output = new URL("../../../artifacts/git-review-pane/", import.meta.url);
    await page.screenshot({
      path: fileURLToPath(new URL("review-v2-mobile.png", output)),
      animations: "disabled",
    });
    await page.setViewportSize({ width: 1280, height: 900 });
  });
  await t.test("实时范围视图绑定审核快照；重新生成回到冻结内容，历史组不进入范围编辑", async () => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(url);
    await page.getByTestId("git-action-trigger").click();
    await ready();
    const generate = page.getByTestId("git-commit-generate-button");
    const generated = (count) =>
      page.waitForFunction(
        (count) =>
          globalThis.__gitCommitFixture.calls.length === count &&
          document.querySelector('[data-testid="git-review-acknowledge"]') &&
          document.querySelector('[data-testid="git-commit-generate-button"]')?.disabled === false,
        count,
      );
    await generate.click();
    await generated(1);
    const manage = page.getByTestId("git-review-manage-range");
    await manage.click();
    await page.getByTestId("git-review-include-a.ts").uncheck();
    await generate.click();
    await generated(2);
    assert.equal(await manage.getAttribute("aria-pressed"), "false");
    assert.match(await page.getByTestId("git-review-diff-content").innerText(), /fixture change/);
    assert.equal(
      await page.getByTestId("git-review-include-a.ts").count(),
      0,
      JSON.stringify(await page.evaluate(() => globalThis.__gitCommitFixture.calls)),
    );
    await fixture("groups", true);
    await generate.click();
    await generated(3);
    await page.getByTestId("git-review-next").click();
    assert.equal(await manage.count(), 0);
    assert.equal(
      await page.getByTestId("review-workspace-files").getByRole("checkbox").first().isDisabled(),
      true,
    );
    assert.deepEqual(await page.evaluate(() => globalThis.__gitCommitFixture.publish.calls), []);
  });
  await t.test("视觉回归：目录层级、未跟踪分组和实际 Diff，浅色/深色与手机", async () => {
    const output = new URL("../../../artifacts/git-review-pane/", import.meta.url);
    for (const light of [true, false]) {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto(`${url}?visualReview${light ? "&light" : ""}`);
      await page.getByTestId("git-action-trigger").click();
      await ready();
      await page.getByTestId("git-review-inline-diff").locator("[data-diff-viewer]").waitFor();
      await page.getByTestId("git-review-include-node-untracked").waitFor();
      await input.fill(
        "feat(git): 将提交审核整合到右侧工作区\n\n统一手动与自动审核入口，保留文件范围、Diff 和提交操作。",
      );
      await page.getByTestId("git-review-include-src/hooks/useReview.ts").uncheck();
      await page
        .getByTestId("review-workspace-files")
        .getByRole("button", { name: "specs", exact: true })
        .click();
      await page
        .getByTestId("review-workspace-files")
        .getByRole("button", { name: "styles", exact: true })
        .click();
      await page
        .getByTestId("review-workspace-files")
        .getByRole("button", { name: "ReviewPanel.tsx", exact: true })
        .click();
      await page.waitForFunction(() =>
        document
          .querySelector('[data-testid="git-review-diff-content"] diffs-container')
          ?.shadowRoot?.querySelector("pre")
          ?.textContent?.includes("activateGitPane"),
      );
      await page.mouse.move(0, 0);
      await page.screenshot({
        path: fileURLToPath(new URL(`review-ide-${light ? "light" : "dark"}.png`, output)),
        animations: "disabled",
      });
      await page.locator("[data-workspace-side-pane-panel]").screenshot({
        path: fileURLToPath(new URL(`review-ide-${light ? "light" : "dark"}-panel.png`, output)),
        animations: "disabled",
      });
      if (light) {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.reload();
        await page.getByTestId("git-action-trigger").click();
        await ready();
        await page.screenshot({
          path: fileURLToPath(new URL("review-ide-mobile.png", output)),
          animations: "disabled",
        });
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  });
}
