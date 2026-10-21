import assert from "node:assert/strict";
export async function runGitHistoryAdvancedCases(t, { page, go, select, control, writes }) {
  await t.test("多选按顺序生成一次批次预览，取消零写入，筛选清除选择", async () => {
    await go();
    await page.getByRole("checkbox", { name: /选择提交 a+/ }).check();
    await page.getByRole("checkbox", { name: /选择提交 b+/ }).check();
    await page
      .getByTestId("git-history-selection")
      .getByRole("button", { name: "Cherry-pick", exact: true })
      .click();
    await page.getByTestId("git-history-batch-order").waitFor();
    const preview = await page.evaluate(
      () => globalThis.__gitHistory.calls.filter((c) => c.method === "preview").at(-1).params,
    );
    assert.deepEqual(preview.targets, ["a".repeat(40), "b".repeat(40)]);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    assert.deepEqual(await writes(), []);
    await page.getByTestId("git-history-filter").click();
    assert.equal(await page.getByTestId("git-history-selection").count(), 0);
  });
  await t.test("Merge 的操作主线与 Diff parent 分开，明确选择后才可预览", async () => {
    await go("?merge");
    await select();
    assert.equal(await page.getByTestId("git-history-cherry-pick").isDisabled(), true);
    await page.getByRole("combobox", { name: "对比父提交", exact: true }).selectOption("2");
    assert.equal(await page.getByTestId("git-history-cherry-pick").isDisabled(), true);
    await page.getByRole("combobox", { name: "操作主线", exact: true }).selectOption("1");
    await page.getByTestId("git-history-cherry-pick").click();
    await page.getByTestId("git-history-confirmation").waitFor();
    assert.equal(
      await page.evaluate(
        () =>
          globalThis.__gitHistory.calls.filter((c) => c.method === "preview").at(-1).params
            .mainline,
      ),
      1,
    );
    assert.deepEqual(await writes(), []);
  });
  await t.test("Reset 菜单/模式/hard 明确确认，远端请求与恢复复用协调入口", async () => {
    await go();
    await control("remote");
    await page.waitForFunction(() =>
      globalThis.__gitHistory.calls.some((c) => c.method === "history" && c.host === "remote"),
    );
    await page.getByTestId("git-history-commit").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Reset…", exact: true }).click();
    await page.getByTestId("git-history-reset-form").waitFor();
    const mode = page.getByRole("combobox", { name: "Reset 模式", exact: true });
    assert.equal(await mode.inputValue(), "soft");
    await mode.selectOption("hard");
    await page.getByRole("button", { name: "预览", exact: true }).click();
    const confirm = page.getByTestId("git-history-confirm");
    assert.equal(await confirm.isDisabled(), true);
    assert.deepEqual(await writes(), []);
    await page
      .getByRole("checkbox", { name: "确认丢弃当前已跟踪文件的暂存和未暂存改动", exact: true })
      .check();
    await confirm.click();
    await page.getByRole("button", { name: "恢复此次 Reset", exact: true }).click();
    await page
      .getByRole("checkbox", { name: "确认恢复 Reset 前的文件与暂存范围", exact: true })
      .check();
    await confirm.click();
    await page.waitForFunction(
      () => globalThis.__gitHistory.calls.filter((c) => c.method === "resetHistory").length === 2,
    );
    const mutations = await writes();
    assert.equal(mutations.length, 2);
    assert.equal(mutations[0].params.workspaceIdentity, "fixture:remote");
    assert.equal(mutations[0].params.confirmDiscard, true);
    assert.equal(mutations[1].params.preview.sourceRequestId, mutations[0].params.requestId);
  });
}
