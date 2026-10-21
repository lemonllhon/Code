import assert from "node:assert/strict";

export async function runGitFileOperationsCases(t, { page, url }) {
  page.setDefaultTimeout(15000);
  const fixtureUrl = new URL("git-file-operations.html", url).href;
  const go = async (query = "") => {
    await page.goto(fixtureUrl + query);
    await page.getByTestId("git-file-stage-all").waitFor();
  };
  const action = (name) => page.evaluate((name) => globalThis.__gitFiles[name](), name);
  const source = (value) => page.evaluate((value) => globalThis.__gitFiles.source(value), value);
  const writes = () =>
    page.evaluate(() => globalThis.__gitFiles.calls.filter((call) => call.method !== "state"));
  await t.test("变更页单文件暂存、全部取消暂存，刷新使用服务事实", async () => {
    await go();
    await page.getByTestId("git-file-stage").first().click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="refresh-count"]').textContent === "1",
    );
    assert.deepEqual((await writes())[0].params.paths, ["src/中文 file.ts"]);
    await source("staged");
    await page.getByTestId("git-file-unstage-all").click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="refresh-count"]').textContent === "2",
    );
    assert.deepEqual((await writes())[1].params.paths.sort(), ["other.ts", "src/中文 file.ts"]);
  });
  await t.test("丢弃确认展示具体范围，取消零写入，staged 明确双区域影响", async () => {
    await go();
    await page.getByTestId("git-file-discard").first().click();
    const dialog = page.getByTestId("git-discard-confirmation");
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /src\/中文 file.ts/);
    await action("loading");
    assert.equal(await page.getByTestId("git-discard-confirm").isDisabled(), true);
    assert.equal(await page.getByTestId("git-discard-cancel").isEnabled(), true);
    await action("loaded");
    await page.getByTestId("git-discard-cancel").click();
    assert.deepEqual(await writes(), []);
    await source("staged");
    await page.getByTestId("git-file-discard-all").click();
    assert.match(await dialog.innerText(), /暂存区和工作树/);
    await page.getByTestId("git-discard-confirm").click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal((await writes())[0].params.staged, true);
  });
  await t.test("过期确认、busy 和写入错误不伪成功；快速双击只发一次命令", async () => {
    await go();
    await page.getByTestId("git-file-discard").first().click();
    await page.getByTestId("git-discard-confirmation").waitFor();
    await action("external");
    await page.getByTestId("git-discard-confirm").click();
    await page.getByTestId("git-file-operation-error").waitFor();
    assert.match(await page.getByTestId("git-file-operation-error").innerText(), /变化/);
    for (const failure of ["busy", "fail"]) {
      await go();
      await action(failure);
      await page.getByTestId("git-file-stage-all").click();
      await page.getByTestId("git-file-operation-error").waitFor();
      assert.equal(await page.getByTestId("git-file-stage").count(), 2);
    }
    await go();
    await action("hold");
    await page.getByTestId("git-file-stage-all").evaluate((button) => {
      button.click();
      button.click();
    });
    await action("release");
    await page.waitForFunction(
      () => document.querySelector('[data-testid="refresh-count"]').textContent === "1",
    );
    assert.equal((await writes()).length, 1);
  });
  await t.test("只读来源隐藏动作；切来源与同路径换 Host 使旧确认和迟到准备失效", async () => {
    await go();
    for (const value of ["branch", "last-turn"]) {
      await source(value);
      assert.equal(await page.getByTestId("git-file-stage").count(), 0);
      assert.equal(await page.getByTestId("git-file-discard-all").count(), 0);
    }
    await source("unstaged");
    await action("hold");
    await page.getByTestId("git-file-discard").first().click();
    await source("staged");
    await action("release");
    await page.getByTestId("git-file-unstage-all").waitFor();
    assert.equal(await page.getByTestId("git-discard-confirmation").count(), 0);
    await page.getByTestId("git-file-discard").first().click();
    await page.getByTestId("git-discard-confirmation").waitFor();
    await action("remote");
    await page.getByTestId("git-discard-confirmation").waitFor({ state: "hidden" });
    await page.getByTestId("git-file-unstage-all").click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="refresh-count"]').textContent === "1",
    );
    const request = (await writes())[0];
    assert.equal(request.host, "remote");
    assert.equal(request.params.workspaceIdentity, "fixture:remote");
    await action("disconnect");
    assert.equal(await page.getByTestId("git-file-stage").count(), 0);
    assert.equal(await page.getByTestId("git-file-unstage-all").count(), 0);
  });
  await t.test(
    "切换辅助发送单一组合命令，提交成功切换失败后关闭旧提交状态；迟到预览不串 Host",
    async () => {
      await go("?branch");
      await action("remote");
      await page.getByTestId("branch-probe-switch").click();
      await page.waitForFunction(
        () => document.querySelector('[data-testid="branch-probe-step"]').textContent === "blocked",
      );
      await page.getByTestId("branch-probe-commit").evaluate((button) => {
        button.click();
        button.click();
      });
      await page.waitForFunction(
        () => document.querySelector('[data-testid="branch-probe-step"]').textContent === "none",
      );
      const commands = await writes();
      assert.deepEqual(
        commands.map((call) => call.method),
        ["switchBranch", "commitAndSwitchBranch"],
      );
      assert.equal(commands[1].host, "remote");
      assert.equal(commands[1].params.workspaceIdentity, "fixture:remote");
      assert.deepEqual(commands[1].params.paths, ["/fixture/repo/src/中文 file.ts"]);
      await go("?branch");
      await action("hold");
      await page.getByTestId("branch-probe-switch").click();
      await page.waitForFunction(() =>
        globalThis.__gitFiles.calls.some((call) => call.method === "state"),
      );
      await action("remote");
      await action("release");
      await page.getByTestId("branch-probe-switch").waitFor();
      assert.equal(await page.getByTestId("branch-probe-step").innerText(), "none");
      assert.equal((await writes()).length, 1);
    },
  );
  await t.test("390px 中英文按钮可达，丢弃范围不撑破窗口", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const query of ["", "?english"]) {
      await go(query);
      await page.getByTestId("git-file-discard-all").click();
      const dialog = page.getByTestId("git-discard-confirmation");
      await dialog.waitFor();
      const box = await dialog.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= 391 && box.y + box.height <= 844);
      assert.match(await dialog.innerText(), query ? /untracked/i : /未跟踪/);
      await page.getByTestId("git-discard-cancel").click();
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  });
}
