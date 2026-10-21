import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
export async function runGitConflictCases(t, { page, url }) {
  page.setDefaultTimeout(15000);
  const fixtureUrl = new URL("git-conflicts.html", url).href;
  const go = async (query = "") => {
    await page.goto(fixtureUrl + query);
    await page.getByTestId("git-view-conflicts").click();
    await page.getByTestId("git-conflict-result-section").waitFor();
    await page.waitForFunction(() =>
      globalThis.__gitConflicts.calls.some((call) => call.method === "file"),
    );
  };
  const act = (method, value) =>
    page.evaluate(({ method, value }) => globalThis.__gitConflicts[method](value), {
      method,
      value,
    });
  const writes = () =>
    page.evaluate(() =>
      globalThis.__gitConflicts.calls.filter((call) =>
        [
          "beginConflictResolution",
          "saveConflictResult",
          "markConflictResolved",
          "completeGitOperation",
        ].includes(call.method),
      ),
    );
  const save = async (text) => {
    await page.getByTestId("git-conflict-result").fill(text);
    await page.getByTestId("git-conflict-save").click();
    await page.getByTestId("git-conflict-confirm").click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="git-conflict-mark"]').disabled === false,
    );
  };
  await t.test("混合行尾必须明确选择，可直接选择 LF，保存收据包含文件路径", async () => {
    await go("?mixed");
    await page.getByTestId("git-conflict-result").fill("resolved LF\n");
    assert.equal(await page.getByTestId("git-conflict-save").isDisabled(), true);
    await page.getByRole("combobox", { name: "保存行尾", exact: true }).selectOption("lf");
    await page.getByTestId("git-conflict-save").click();
    await page.getByTestId("git-conflict-confirm").click();
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="git-conflict-mark"]').disabled,
    );
    assert.equal((await writes())[0].params.text, "resolved LF\n");
    assert.match(await page.getByTestId("git-workspace-receipt").innerText(), /src\/main.ts/);
  });
  await t.test("三方来自不同 stages，宽屏三栏和窄屏版本页签；查看无写入", async () => {
    await go("?wide");
    for (const key of ["base", "ours", "theirs"])
      assert.equal(await page.getByTestId(`git-conflict-version-${key}`).isVisible(), true);
    for (const key of ["ours", "theirs"]) {
      const host = page.getByTestId(`git-conflict-diff-${key}`);
      await host.locator("diffs-container").waitFor();
      await page.waitForFunction((side) => {
        const text = document
          .querySelector(`[data-testid="git-conflict-diff-${side}"] diffs-container`)
          ?.shadowRoot?.querySelector("pre")?.textContent;
        return text?.includes("base") && text.includes(side);
      }, key);
    }
    assert.deepEqual(await writes(), []);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("git-conflict-tab-base").click();
    assert.match(await page.getByTestId("git-conflict-version-base").innerText(), /base/);
    await page.getByTestId("git-conflict-tab-result").click();
    assert.equal(await page.getByTestId("git-conflict-result").isVisible(), true);
    await page.setViewportSize({ width: 1280, height: 900 });
  });
  await t.test("Stash 恢复入口进入同一侧栏，保存与标记独立，保留原操作直至完成", async () => {
    await page.goto(fixtureUrl);
    await page.getByTestId("git-view-stash").click();
    await page.getByRole("button", { name: "进入人工解决", exact: true }).click();
    await page.getByTestId("git-conflict-result").waitFor();
    assert.equal(await page.getByTestId("git-conflict-mark").isDisabled(), true);
    await save("手动结果\n");
    assert.equal((await writes()).length, 1);
    assert.equal((await writes())[0].method, "saveConflictResult");
    assert.match(await page.getByTestId("git-conflict-files").innerText(), /src\/main.ts/);
    await page.getByTestId("git-conflict-mark").click();
    assert.match(await page.getByTestId("git-conflict-confirmation").innerText(), /不提交、不继续/);
    await page.getByTestId("git-conflict-confirm").click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="git-conflict-path"]').textContent ===
        "src/secondary.ts",
    );
    await page.getByTestId("git-conflict-mark").click();
    await page.getByTestId("git-conflict-confirm").click();
    await page.getByTestId("git-conflict-files").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "检查处理结果", exact: true }).click();
    await page.getByTestId("git-operation-complete").click();
    await page.getByTestId("git-operation-recovery").waitFor({ state: "detached" });
    assert.equal((await writes()).length, 4);
  });
  await t.test("外部冲突显式接管；删除结果后仍须单独标记", async () => {
    await go("?external");
    assert.equal(await page.getByTestId("git-conflict-result").isDisabled(), true);
    assert.deepEqual(await writes(), []);
    await page.getByTestId("git-conflict-begin").click();
    await page.getByTestId("git-conflict-confirm").click();
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="git-conflict-result"]').disabled,
    );
    await page.getByTestId("git-conflict-delete").click();
    await page.getByTestId("git-conflict-confirm").click();
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="git-conflict-mark"]').disabled,
    );
    assert.equal((await writes()).length, 2);
    await page.getByTestId("git-conflict-mark").click();
    await page.getByTestId("git-conflict-confirm").click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="git-conflict-path"]').textContent ===
        "src/secondary.ts",
    );
    assert.equal((await writes())[1].params.action, "delete");
  });
  await t.test("刷新和切文件保护草稿；切工具重开保留，外部变化禁用旧草稿保存", async () => {
    await go();
    const input = page.getByTestId("git-conflict-result");
    await input.fill("我的草稿\n");
    await page.getByRole("button", { name: "刷新冲突状态", exact: true }).click();
    await page.getByTestId("git-conflict-draft-guard").waitFor();
    await page.getByRole("button", { name: "保留草稿", exact: true }).click();
    assert.equal(await input.inputValue(), "我的草稿\n");
    await page.getByTestId("git-view-changes").click();
    await page.getByTestId("git-view-conflicts").click();
    await input.waitFor();
    assert.equal(await input.inputValue(), "我的草稿\n");
    await act("externalChange");
    await page.getByTestId("git-view-changes").click();
    await page.getByTestId("git-view-conflicts").click();
    await page.getByRole("alert").filter({ hasText: "文件版本已变化" }).waitFor();
    assert.equal(await input.inputValue(), "我的草稿\n");
    assert.equal(await page.getByTestId("git-conflict-save").isDisabled(), true);
    await page.getByRole("button", { name: "刷新冲突状态", exact: true }).click();
    await page.getByRole("button", { name: "放弃草稿并继续", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="git-conflict-result"]').value === "external\n",
    );
    assert.deepEqual(await writes(), []);
  });
  await t.test("同路径换 Host 丢弃旧确认，迟到读取不覆盖，远端请求贯穿 identity", async () => {
    await go();
    await act("hold");
    await page.getByRole("button", { name: "刷新冲突状态", exact: true }).click();
    await act("remote");
    await act("release");
    await page.waitForFunction(() => {
      const input = document.querySelector('[data-testid="git-conflict-result"]');
      return input && !input.disabled;
    });
    await save("remote result\n");
    const call = (await writes())[0];
    assert.equal(call.host, "remote");
    assert.equal(call.params.workspaceIdentity, "fixture:remote");
    assert.equal(call.params.workspacePath, "/fixture/repo");
    await act("disconnect");
    await page.waitForFunction(() => {
      const button = document.querySelector('[data-testid="git-conflict-save"]');
      return !button || button.disabled;
    });
  });
  await t.test("丢回执只查询，重开保留草稿并因新版本阻止重放", async () => {
    await go();
    await page.getByTestId("git-conflict-result").fill("saved once\n");
    await page.getByTestId("git-conflict-save").click();
    await act("lostAck");
    await page.getByTestId("git-conflict-confirm").click();
    await page.getByTestId("git-workspace-error").waitFor();
    await page.getByTestId("git-view-changes").click();
    await page.getByTestId("git-view-conflicts").click();
    await page.getByTestId("git-workspace-receipt").waitFor();
    assert.equal((await writes()).length, 1);
    assert.equal(await page.getByTestId("git-conflict-save").isDisabled(), true);
  });
  await t.test("二进制分流无文本编辑，标记需确认外部处理", async () => {
    await go("?binary");
    assert.equal(await page.getByTestId("git-conflict-result").count(), 0);
    assert.equal(await page.getByTestId("git-conflict-save").isDisabled(), true);
    await page.getByTestId("git-conflict-mark").click();
    assert.equal(await page.getByTestId("git-conflict-confirm").isDisabled(), true);
    await page
      .getByRole("checkbox", {
        name: "我已用外部工具处理并检查当前结果文件，确认按此内容暂存。",
        exact: true,
      })
      .check();
    await page.getByTestId("git-conflict-confirm").click();
    await page.waitForFunction(() =>
      globalThis.__gitConflicts.calls.some((call) => call.method === "markConflictResolved"),
    );
    assert.equal((await writes())[0].params.confirmSpecial, true);
  });
  await t.test("390px 中英文浅暗主题无横向溢出，键盘和底栏可达", async () => {
    await mkdir("artifacts/git-conflicts", { recursive: true });
    for (const query of ["", "?english&dark"]) {
      await page.setViewportSize({ width: 390, height: 844 });
      await go(query);
      const input = page.getByTestId("git-conflict-result");
      await input.focus();
      await input.fill("resolved\n");
      assert.ok(await input.evaluate((node) => parseFloat(getComputedStyle(node).fontSize) >= 16));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.getByTestId("git-conflict-save").focus();
      assert.equal(
        await page
          .getByTestId("git-conflict-save")
          .evaluate((node) => node === document.activeElement),
        true,
      );
      await page.screenshot({
        path: `artifacts/git-conflicts/${query ? "english-dark" : "chinese-light"}.png`,
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await go("?wide");
    await page.screenshot({
      path: "artifacts/git-conflicts/three-way-desktop.png",
      fullPage: true,
    });
  });
}
