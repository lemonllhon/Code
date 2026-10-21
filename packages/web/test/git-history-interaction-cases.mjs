import assert from "node:assert/strict";
export async function runGitHistoryInteractionCases(t, { page, go, select, control, writes }) {
  await t.test("统一搜索开关和定位同步草稿，千行历史仅渲染视区，End 跨屏焦点可达", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await go("?wide&many");
    assert.ok((await page.getByTestId("git-history-commit").count()) < 70);
    const rows = page.getByTestId("git-history-commit");
    await rows.first().focus();
    await rows.first().press("End");
    await page.waitForFunction(
      () =>
        document.activeElement?.getAttribute("data-commit-hash") ===
        (998).toString(16).padStart(40, "0"),
    );
    assert.ok((await rows.count()) < 70);
    await page.getByRole("button", { name: "正则表达式", exact: true }).click();
    await page.getByRole("button", { name: "区分大小写", exact: true }).click();
    await page.getByRole("textbox", { name: "消息或 Hash", exact: true }).fill("feat.*");
    await page.getByTestId("git-history-filter").click();
    assert.equal(
      await page.evaluate(
        () =>
          globalThis.__gitHistory.calls.filter((c) => c.method === "history").at(-1).params
            .searchMode,
      ),
      "regex",
    );
    await page.getByRole("button", { name: "定位提交", exact: true }).click();
    await page.getByRole("textbox", { name: "提交 Hash 或完整 Ref", exact: true }).fill("HEAD");
    await page.getByRole("textbox", { name: "提交 Hash 或完整 Ref", exact: true }).press("Enter");
    await page.getByTestId("git-history-detail").waitFor();
    assert.equal(
      await page.getByRole("textbox", { name: "消息或 Hash", exact: true }).inputValue(),
      "",
    );
    assert.equal(
      await page
        .getByRole("button", { name: "正则表达式", exact: true })
        .getAttribute("aria-pressed"),
      "false",
    );
    assert.deepEqual(await writes(), []);
  });
  await t.test("候选搜索仅更新草稿，显式应用完整 ref/作者，迟到候选隔离 Host", async () => {
    await go();
    await page.getByTestId("git-history-advanced-toggle").click();
    await page.getByRole("combobox", { name: "选择分支或标签", exact: true }).click();
    await page.getByPlaceholder("搜索候选").fill("feature/中文");
    await page.getByRole("option").first().click();
    assert.equal(
      await page
        .getByRole("textbox", { name: "分支/标签完整 Ref 或 OID（全部）", exact: true })
        .inputValue(),
      "refs/heads/feature/中文",
    );
    await page.getByRole("combobox", { name: "选择作者", exact: true }).click();
    await page.getByRole("option").first().click();
    await page.getByTestId("git-history-filter").click();
    const params = await page.evaluate(
      () => globalThis.__gitHistory.calls.filter((c) => c.method === "history").at(-1).params,
    );
    assert.equal(params.ref, "refs/heads/feature/中文");
    assert.equal(params.author, "fixture@example.invalid");
    await control("hold");
    await page.getByRole("combobox", { name: "选择作者", exact: true }).click();
    await control("remote");
    await control("release");
    await page.waitForFunction(() =>
      globalThis.__gitHistory.calls.some((c) => c.host === "remote" && c.method === "history"),
    );
    assert.deepEqual(await writes(), []);
  });
  await t.test("目录键盘折叠与文件选择，列宽键盘/拖动/复位均只读", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await go("?wide");
    await select();
    const dir = page.getByTestId("git-history-directory").first();
    await dir.focus();
    await dir.press("ArrowLeft");
    assert.equal(await page.getByTestId("git-history-file").count(), 0);
    await dir.press("ArrowRight");
    await dir.press("ArrowRight");
    await page.keyboard.press("Enter");
    await page.getByTestId("git-history-diff").waitFor();
    const handle = page.getByRole("separator", { name: "调整作者列宽", exact: true });
    await handle.focus();
    await handle.press("ArrowRight");
    assert.equal(await handle.getAttribute("aria-valuenow"), "104");
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + 5, box.y + 8);
    await page.mouse.down();
    await page.mouse.move(box.x + 45, box.y + 8);
    await page.mouse.up();
    assert.ok(Number(await handle.getAttribute("aria-valuenow")) > 104);
    await handle.press("Home");
    assert.equal(await handle.getAttribute("aria-valuenow"), "96");
    assert.deepEqual(await writes(), []);
  });
  await t.test("图谱键盘选中和右键指向实际行，取消零写入，菜单复用原确认", async () => {
    await go();
    const rows = page.getByTestId("git-history-commit");
    await rows.first().focus();
    await rows.first().press("ArrowDown");
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="git-history-detail"] header span[title]')
          ?.getAttribute("title") === "a".repeat(40),
    );
    await rows.first().click({ button: "right" });
    await page.keyboard.press("Escape");
    assert.deepEqual(await writes(), []);
    await rows.first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Cherry-pick", exact: true }).click();
    await page.getByTestId("git-history-confirmation").waitFor();
    assert.equal(
      await page.evaluate(
        () =>
          globalThis.__gitHistory.calls.filter((c) => c.method === "preview").at(-1).params
            .targetRef,
      ),
      "b".repeat(40),
    );
    assert.deepEqual(await writes(), []);
  });
  await t.test("Shift+F10 和手机更多共用菜单，Tag 定位目标，merge 禁用缺主线操作", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await go("?merge");
    const row = page.getByTestId("git-history-commit").first();
    await row.focus();
    await row.press("Shift+F10");
    assert.equal(
      await page
        .getByRole("menuitem", { name: "Cherry-pick", exact: true })
        .getAttribute("aria-disabled"),
      "true",
    );
    await page.getByRole("menuitem", { name: "创建 Tag", exact: true }).click();
    await page.getByTestId("git-history-tag-form").waitFor();
    await page.getByRole("button", { name: /提交 b+ 的操作/ }).click();
    await page.keyboard.press("Escape");
    assert.deepEqual(await writes(), []);
  });
}
