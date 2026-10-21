import assert from "node:assert/strict";
export async function runGitHistoryLayoutCases(
  t,
  { page, go, select, control, writes, artifactPath },
) {
  await t.test("分页上限明确提示并停止入口，万行历史 DOM 保持有界", async () => {
    await go("?wide&cap");
    assert.equal(await page.getByTestId("git-history-limit").isVisible(), true);
    assert.equal(await page.getByTestId("git-history-more").count(), 0);
    assert.ok((await page.getByTestId("git-history-commit").count()) < 70);
    assert.deepEqual(await writes(), []);
  });
  await t.test("历史 Diff 上下文提示中英文一致，展开按钮可通过键盘展开真实内容", async () => {
    for (const english of [false, true]) {
      await go(english ? "?context&english" : "?context");
      await select();
      await page.getByTestId("git-history-file").first().click();
      const label = page.getByText(english ? /\d+ unmodified lines/ : /\d+ 行未改动/).first();
      await label.waitFor();
      const before = await page.locator("[data-line]").count();
      const expand = page
        .getByRole("button", { name: english ? /Expand context/ : /展开.*上下文/ })
        .first();
      await expand.press("Enter");
      await page.waitForFunction(
        (count) =>
          [...document.querySelectorAll("diffs-container")].reduce(
            (sum, node) => sum + (node.shadowRoot?.querySelectorAll("[data-line]").length ?? 0),
            0,
          ) > count,
        before,
      );
      assert.deepEqual(await writes(), []);
    }
  });
  await t.test("最大界面字号下行高与图形同步，窄栏不裁剪或横向溢出", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await go("?wide&dark&font=20");
    const row = await page.getByTestId("git-history-commit").first().boundingBox();
    assert.ok(row.height >= 56);
    const circle = await page
      .getByRole("img", { name: "Git 提交图", exact: true })
      .locator("circle")
      .first()
      .boundingBox();
    assert.ok(Math.abs(row.y + row.height / 2 - circle.y - circle.height / 2) < 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: artifactPath("font-20-mobile.png") });
    assert.deepEqual(await writes(), []);
  });
  await t.test("预览未返回时锁定关闭，关闭详情清除已准备确认而不写入", async () => {
    await go();
    await select();
    await page.getByTestId("git-history-file").first().click();
    await page.getByTestId("git-history-diff").waitFor();
    await control("hold");
    await page.getByTestId("git-history-cherry-pick").click();
    assert.equal(
      await page.getByRole("button", { name: "关闭提交详情", exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await page.getByRole("button", { name: "关闭差异", exact: true }).isDisabled(),
      true,
    );
    await control("release");
    await page.getByTestId("git-history-confirmation").waitFor();
    await page.getByRole("button", { name: "关闭提交详情", exact: true }).click();
    assert.equal(await page.getByTestId("git-history-confirmation").count(), 0);
    assert.equal(await page.getByTestId("git-history-detail").count(), 0);
    assert.deepEqual(await writes(), []);
  });
  await t.test("390/512/1280px 始终保留同一图谱与 Ref，历史随可用高度伸展", async () => {
    for (const width of [390, 512, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await go("?wide&dark");
      assert.equal(await page.getByTestId("git-history-commit").count(), 2);
      assert.equal(
        await page.getByRole("img", { name: "Git 提交图", exact: true }).isVisible(),
        true,
      );
      assert.equal(await page.getByText("HEAD", { exact: true }).isVisible(), true);
      assert.equal(await page.getByTestId("git-history-advanced").count(), 0);
      const graph = page.getByTestId("git-history-graph");
      const first = await graph.boundingBox();
      assert.ok(first.height > 700);
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="git-history-graph"]').getBoundingClientRect()
            .height > 850,
      );
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(await writes(), []);
      await page.screenshot({ path: artifactPath(`layout-${width}.png`) });
    }
  });
  await t.test("筛选收起保留草稿；提交字面条件、刷新与显式重置走原只读入口", async () => {
    await go();
    await page.getByTestId("git-history-advanced-toggle").click();
    const author = page.getByRole("textbox", { name: "作者", exact: true });
    await author.fill("[Fixture]");
    await page.getByTestId("git-history-advanced-toggle").click();
    assert.equal(await page.getByTestId("git-history-advanced").count(), 0);
    await page.getByTestId("git-history-advanced-toggle").click();
    assert.equal(await author.inputValue(), "[Fixture]");
    await page.getByTestId("git-history-filter").click();
    await page.getByRole("button", { name: "刷新历史", exact: true }).click();
    let requests = await page.evaluate(() =>
      globalThis.__gitHistory.calls.filter((c) => c.method === "history"),
    );
    assert.equal(requests.at(-1).params.author, "[Fixture]");
    await author.fill("");
    assert.equal(await page.getByTestId("git-history-reset").isVisible(), true);
    await page.getByTestId("git-history-reset").click();
    requests = await page.evaluate(() =>
      globalThis.__gitHistory.calls.filter((c) => c.method === "history"),
    );
    assert.equal(requests.at(-1).params.author, undefined);
    assert.equal(await author.inputValue(), "");
    assert.deepEqual(await writes(), []);
  });
  await t.test(
    "历史/详情和文件/Diff 分隔条可拖动与键盘调整，选择不重置比例，关闭恢复空间",
    async () => {
      await page.setViewportSize({ width: 512, height: 900 });
      await go("?wide");
      await select();
      const graph = page.getByTestId("git-history-graph");
      const split = page.getByRole("separator", { name: "调整历史和详情高度", exact: true });
      const before = await graph.boundingBox();
      await split.focus();
      await split.press("ArrowUp");
      await page.waitForFunction(
        (height) =>
          document.querySelector('[data-testid="git-history-graph"]').getBoundingClientRect()
            .height <
          height - 1,
        before.height,
      );
      const keyboard = await graph.boundingBox();
      const handle = await split.boundingBox();
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 - 45, {
        steps: 5,
      });
      await page.mouse.up();
      const dragged = await graph.boundingBox();
      assert.ok(dragged.height < keyboard.height - 20);
      await page.getByTestId("git-history-commit").nth(1).click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="git-history-detail"] header span[title]')
            ?.getAttribute("title") === "a".repeat(40),
      );
      assert.ok(Math.abs((await graph.boundingBox()).height - dragged.height) < 2);
      await page.getByTestId("git-history-file").first().click();
      await page.getByTestId("git-history-diff").waitFor();
      const diffSplit = page.getByRole("separator", { name: "调整文件与差异高度", exact: true });
      const diffBefore = await page.getByTestId("git-history-diff").boundingBox();
      await diffSplit.focus();
      await diffSplit.press("ArrowUp");
      await page.waitForFunction(
        (height) =>
          document.querySelector('[data-testid="git-history-diff"]').getBoundingClientRect()
            .height >
          height + 1,
        diffBefore.height,
      );
      await page.getByRole("button", { name: "关闭差异", exact: true }).click();
      assert.equal(await page.getByTestId("git-history-diff").count(), 0);
      await page.getByRole("button", { name: "关闭提交详情", exact: true }).click();
      assert.equal(await page.getByTestId("git-history-detail").count(), 0);
      assert.ok((await graph.boundingBox()).height > before.height + 100);
      await page.getByRole("button", { name: "显示提交详情", exact: true }).click();
      await page.getByTestId("git-history-detail").waitFor();
      assert.deepEqual(await writes(), []);
    },
  );
  await t.test("图形节点与提交行对齐，长历史滚动保持表头，七种主题不丢图形或选中态", async () => {
    await page.setViewportSize({ width: 390, height: 600 });
    await go("?wide&many&dark");
    const row = await page.getByTestId("git-history-commit").first().boundingBox();
    const circle = await page
      .getByRole("img", { name: "Git 提交图", exact: true })
      .locator("circle")
      .first()
      .boundingBox();
    assert.ok(Math.abs(row.y + row.height / 2 - circle.y - circle.height / 2) < 1);
    const header = page.getByText("描述", { exact: true });
    const before = await header.boundingBox();
    await page.getByTestId("git-history-scroll").hover();
    await page.mouse.wheel(0, 400);
    await page.waitForFunction(
      () => document.querySelector('[data-testid="git-history-scroll"]').scrollTop > 0,
    );
    assert.ok(Math.abs((await header.boundingBox()).y - before.y) < 1);
    assert.deepEqual(await writes(), []);
    await page.emulateMedia({ colorScheme: "light" });
    for (const theme of [
      "zai-dark",
      "zai-light",
      "sepia-light",
      "midnight-blue",
      "forest-dark",
      "cinnabar",
      "inkpurple",
    ]) {
      await go(`?wide&theme=${theme}`);
      await select();
      const selected = page.getByTestId("git-history-commit").first();
      const other = page.getByTestId("git-history-commit").nth(1);
      assert.notEqual(
        await selected.evaluate((el) => getComputedStyle(el).backgroundColor),
        await other.evaluate((el) => getComputedStyle(el).backgroundColor),
      );
      assert.equal(
        await page.getByRole("img", { name: "Git 提交图", exact: true }).isVisible(),
        true,
      );
      const stroke = await page
        .getByRole("img", { name: "Git 提交图", exact: true })
        .locator("path")
        .first()
        .evaluate((el) => getComputedStyle(el).stroke);
      assert.ok(stroke !== "none" && stroke !== "rgba(0, 0, 0, 0)");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await page.emulateMedia({ colorScheme: null });
    assert.deepEqual(await writes(), []);
  });
  await t.test("短窗口动作固定可达，高级筛选与确认有界，调整不产生 Git 写入", async () => {
    await page.setViewportSize({ width: 390, height: 480 });
    await go("?wide&english&dark");
    await select();
    const action = await page.getByTestId("git-history-cherry-pick").boundingBox();
    assert.ok(action.y >= 0 && action.y + action.height <= 480);
    await page.getByTestId("git-history-tag-open").click();
    await page.getByRole("textbox", { name: "Tag name", exact: true }).fill("test-layout");
    await page.getByRole("textbox", { name: "Tag message", exact: true }).fill("layout");
    await page.getByTestId("git-history-tag-preview").click();
    const confirm = page.getByTestId("git-history-confirmation");
    assert.equal(await confirm.isVisible(), true);
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("data-testid")),
      "git-history-confirmation",
    );
    assert.ok(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          document.documentElement.scrollHeight <= innerHeight,
      ),
    );
    assert.deepEqual(await writes(), []);
    await page.screenshot({ path: artifactPath("layout-short-confirmation.png") });
  });
}
