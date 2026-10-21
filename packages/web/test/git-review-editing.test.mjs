import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test("提交消息编辑、范围与完成状态", { timeout: 150000 }, async (t) => {
  const { browser, port } = await startWorkflowProgressBrowser(t);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const url = `http://127.0.0.1:${port}/test/fixtures/git-commit-dialog.html`;
  const fixture = (method, ...args) =>
    page.evaluate(({ method, args }) => globalThis.__gitCommitFixture[method](...args), {
      method,
      args,
    });
  const input = page.getByTestId("git-commit-message-input");
  const submit = page.getByTestId("git-commit-action-item-commit");
  const ready = async () => {
    await input.waitFor();
    await page.waitForFunction(async () => {
      const snapshot = await globalThis.__gitCommitFixture.readReviewWorkspace();
      return Boolean(snapshot) && !document.querySelector('[data-testid="review-sync-status"]');
    });
  };
  const manual = async () => {
    await page.goto(url);
    await page.getByTestId("git-action-trigger").click();
    await ready();
  };
  await mkdir("artifacts/git-review-editing", { recursive: true });
  for (const width of [1280, 390])
    await t.test(`${width}px 输入与保存回执不移动编辑区，焦点和选区保留`, async () => {
      await page.setViewportSize({ width, height: 900 });
      await manual();
      // 手机抽屉只允许主动点击/Tab 开始编辑；程序化 focus 会被防键盘自动弹出的策略拦截。
      await input.click();
      const before = await input.boundingBox();
      await fixture("holdDraftSave");
      await input.pressSequentially("fix: stable text");
      await page
        .waitForFunction(() => globalThis.__gitCommitFixture.draftSavePending(), undefined, {
          timeout: 5000,
        })
        .catch(async (error) => {
          throw new Error(
            JSON.stringify(
              await input.evaluate((el) => ({
                value: el.value,
                active: document.activeElement?.outerHTML.slice(0, 400),
                disabled: el.disabled,
              })),
            ),
            { cause: error },
          );
        });
      const during = await input.boundingBox();
      await page.screenshot({ path: `artifacts/git-review-editing/input-saving-${width}.png` });
      try {
        assert.ok(Math.abs(before.y - during.y) < 1, JSON.stringify({ before, during }));
        assert.equal(await input.evaluate((el) => el === document.activeElement), true);
        assert.equal(await input.inputValue(), "fix: stable text");
        await input.evaluate((el) => el.setSelectionRange(5, 11));
      } finally {
        await fixture("releaseDraftSave");
      }
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="git-commit-action-item-commit"]')?.disabled,
      );
      const after = await input.boundingBox();
      assert.ok(Math.abs(before.y - after.y) < 1, JSON.stringify({ before, after }));
      assert.deepEqual(await input.evaluate((el) => [el.selectionStart, el.selectionEnd]), [5, 11]);
    });
  await t.test("普通手动范围修改立即可提交，不要求模型再生成", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await manual();
    await input.fill("fix: 手动范围");
    await page.getByTestId("git-review-include-a.ts").uncheck();
    const shared = await fixture("readReviewWorkspace");
    assert.equal(shared.data.draft.requiresRegeneration, false);
    await submit.click();
    await page.getByTestId("git-commit-review-pane").waitFor({ state: "hidden" });
    const calls = await page.evaluate(() => globalThis.__gitCommitFixture.publish.calls);
    assert.deepEqual(calls.find((call) => call.method === "commit").params.paths, [
      "b.ts",
      "workflow.ts",
    ]);
    assert.equal((await page.evaluate(() => globalThis.__gitCommitFixture.calls)).length, 0);
  });
  await t.test("最终成功以一个 admission 清空审核草稿与范围，再次打开自动读取新文件", async () => {
    await page.goto(url);
    await fixture("automatic");
    await input.waitFor();
    await page.getByTestId("git-review-acknowledge").check();
    await page.evaluate(() => {
      globalThis.__gitCommitFixture.reviewWorkspaceCommands.length = 0;
    });
    await submit.click();
    await page.getByTestId("git-commit-review-pane").waitFor({ state: "hidden" });
    await page.waitForFunction(
      async () =>
        (await globalThis.__gitCommitFixture.readReviewWorkspace()).data.sourceReview === null,
    );
    const commands = await page.evaluate(
      () => globalThis.__gitCommitFixture.reviewWorkspaceCommands,
    );
    const completion = commands.filter((c) => Object.hasOwn(c.patch, "draft"));
    assert.equal(completion.length, 1, JSON.stringify(commands));
    assert.equal(completion[0].patch.sourceReview, null);
    assert.equal(completion[0].patch.selectedPaths, null);
    assert.deepEqual(completion[0].patch.excludedFiles, []);
    assert.equal(completion[0].patch.draft.requiresRegeneration, false);
    await fixture("dirty", ["next.ts"]);
    await page.getByTestId("git-action-trigger").click();
    await ready();
    await page.getByTestId("git-review-include-next.ts").waitFor();
    assert.equal(await input.inputValue(), "");
    assert.equal(
      await page
        .getByText("文件范围或保留的审核已变化，文本已保留。请重新生成审核后再提交。", {
          exact: true,
        })
        .count(),
      0,
    );
  });
  await t.test("提交 warning 保留人工消息和原冻结范围，继续阻止未经审核的提交", async () => {
    await page.goto(url);
    await fixture("automatic");
    await input.waitFor();
    await input.fill("fix: 人工消息需要保留");
    await page.getByTestId("git-review-acknowledge").check();
    await page.evaluate(() =>
      globalThis.__gitCommitFixture.publish.warnCommit("fixture-recovery-warning"),
    );
    await submit.click();
    await page.getByRole("alert").filter({ hasText: "fixture-recovery-warning" }).waitFor();
    assert.equal(await input.inputValue(), "fix: 人工消息需要保留");
    const shared = await fixture("readReviewWorkspace");
    assert.ok(shared.data.sourceReview?.id);
    assert.equal(shared.data.draft.requiresRegeneration, true);
    assert.equal(await submit.isDisabled(), true);
  });
  await t.test("旧失效状态可只读重核并明确改用手动范围，保留文本且不自动调用模型", async () => {
    await manual();
    await input.fill("fix: 已保留的人工信息");
    const old = await fixture("readReviewWorkspace");
    await fixture("patchReviewWorkspace", {
      draft: { ...old.data.draft, requiresRegeneration: true },
    });
    await page.getByTestId("git-review-manual-current-range").click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="git-commit-action-item-commit"]')?.disabled === false,
    );
    assert.equal(await input.inputValue(), "fix: 已保留的人工信息");
    assert.equal((await fixture("readReviewWorkspace")).data.draft.requiresRegeneration, false);
    assert.equal((await page.evaluate(() => globalThis.__gitCommitFixture.calls)).length, 0);
    await submit.click();
    await page.getByTestId("git-commit-review-pane").waitFor({ state: "hidden" });
  });
  for (const replace of [false, true])
    await t.test(`迟到冻结读取不覆盖${replace ? "同 ID 新版本" : "已清理的引用"}`, async () => {
      await page.goto(url);
      await fixture("automatic");
      await ready();
      const saved = await fixture("readReviewWorkspace");
      await fixture("holdFrozenRead");
      await fixture("patchReviewWorkspace", { sourceReview: saved.data.sourceReview });
      await page.waitForFunction(() => globalThis.__gitCommitFixture.frozenReadPending());
      await fixture("patchReviewWorkspace", {
        sourceReview: replace ? saved.data.sourceReview : null,
        draft: { ...saved.data.draft, message: "fix: 新的审核状态", requiresRegeneration: false },
      });
      await fixture("releaseFrozenRead");
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="git-commit-message-input"]')?.value ===
          "fix: 新的审核状态",
      );
      const state = await fixture("readReviewWorkspace");
      assert.equal(state.data.draft.requiresRegeneration, false);
      assert.equal(
        state.data.sourceReview?.id ?? null,
        replace ? saved.data.sourceReview.id : null,
      );
    });
  await t.test("冻结范围变化仍阻止旧提交，显式选择手动模式才解除门禁", async () => {
    await manual();
    await page.getByTestId("git-commit-generate-button").click();
    await page.getByTestId("git-review-acknowledge").waitFor();
    await page.getByTestId("git-review-manage-range").click();
    await page.getByTestId("git-review-include-a.ts").uncheck();
    await page.getByTestId("git-review-regenerate").waitFor();
    assert.equal(await submit.isDisabled(), true);
    await input.press("Control+Enter");
    assert.equal(
      (await page.evaluate(() => globalThis.__gitCommitFixture.publish.calls)).length,
      0,
    );
    await page.getByTestId("git-review-manual-current-range").click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="git-commit-action-item-commit"]')?.disabled === false,
    );
    assert.equal((await page.evaluate(() => globalThis.__gitCommitFixture.calls)).length, 1);
    await submit.click();
    await page.getByTestId("git-commit-review-pane").waitFor({ state: "hidden" });
  });
  await t.test("文件分页、搜索、Diff 及分区调整后输入不重置布局或重复读取 Diff", async () => {
    await page.goto(url);
    await fixture(
      "dirty",
      Array.from({ length: 61 }, (_, i) => `src/file-${String(i).padStart(2, "0")}.ts`),
    );
    await page.getByTestId("git-action-trigger").click();
    await ready();
    await page.getByTestId("git-review-diff-content").locator("[data-diff-viewer]").waitFor();
    const initial = await input.boundingBox();
    await page
      .getByTestId("review-file-pagination")
      .getByRole("button", { name: "下一页", exact: true })
      .click();
    const search = page.getByRole("textbox", { name: "搜索文件路径", exact: true });
    await search.fill("file-60");
    assert.ok(Math.abs((await input.boundingBox()).y - initial.y) < 1);
    await search.clear();
    const divider = page.getByTestId("git-review-body").getByRole("separator").first();
    await divider.press("ArrowUp");
    const resized = await input.boundingBox();
    assert.ok(Math.abs(resized.y - initial.y) > 1, JSON.stringify({ initial, resized }));
    const queries = (await page.evaluate(() => globalThis.__gitCommitFixture.diffQueries)).length;
    await input.click();
    await input.pressSequentially("fix: layout");
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="git-commit-action-item-commit"]')?.disabled === false,
    );
    assert.ok(Math.abs((await input.boundingBox()).y - resized.y) < 1);
    assert.equal(
      (await page.evaluate(() => globalThis.__gitCommitFixture.diffQueries)).length,
      queries,
    );
    await input.dispatchEvent("compositionstart", { data: "修" });
    await page.keyboard.insertText("修复提交");
    await input.dispatchEvent("compositionend", { data: "修复提交" });
    assert.match(await input.inputValue(), /修复提交/);
    assert.equal(await input.evaluate((el) => el === document.activeElement), true);
  });
  assert.deepEqual(errors, []);
});
