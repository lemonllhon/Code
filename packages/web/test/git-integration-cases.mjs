import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
export async function runGitIntegrationCases(t, { page, url }) {
  page.setDefaultTimeout(15000);
  const fixtureUrl = new URL("git-integration.html", url).href;
  const go = async (query = "") => {
    await page.goto(fixtureUrl + query);
    await page.getByTestId("git-view-integration").click();
    await page.waitForFunction(() =>
      globalThis.__gitIntegration.calls.some((call) => call.method === "snapshot"),
    );
  };
  const control = (method) => page.evaluate((name) => globalThis.__gitIntegration[name](), method);
  const writes = () =>
    page.evaluate(() =>
      globalThis.__gitIntegration.calls.filter((call) =>
        /Integration$|ConflictResult$|ConflictResolved$/.test(call.method),
      ),
    );
  const prepare = async (mode = "merge") => {
    await page.getByRole("combobox", { name: /整合方式|Method/, exact: true }).selectOption(mode);
    await page.getByTestId("git-integration-target").fill("refs/heads/topic");
    await page.getByTestId("git-integration-start").click();
    await page.getByTestId("git-integration-confirmation").waitFor();
  };
  const start = async (mode = "merge") => {
    await prepare(mode);
    await page.getByTestId("git-integration-confirm").click();
    await page.getByTestId("git-integration-active").waitFor();
  };
  const resolve = async (text) => {
    await page.getByTestId("git-integration-resolve").click();
    await page.getByTestId("git-conflict-result").fill(text);
    await page.getByTestId("git-conflict-save").click();
    await page.getByTestId("git-conflict-confirm").click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="git-conflict-mark"]')?.disabled === false,
    );
    await page.getByTestId("git-conflict-mark").click();
    await page.getByTestId("git-conflict-confirm").click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="git-conflict-result"]') === null,
    );
    await page.getByTestId("git-conflict-integration").click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="git-integration-continue"]')?.disabled === false,
    );
  };
  await t.test("右侧整合先预览冻结 OID，取消不写入，确认 Merge 进入同一冲突 owner", async () => {
    await go();
    await prepare();
    assert.match(
      await page.getByTestId("git-integration-confirmation").innerText(),
      /bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/,
    );
    assert.deepEqual(await writes(), []);
    assert.equal(await page.getByRole("dialog").count(), 0);
    await page
      .getByTestId("git-integration-confirmation")
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await start();
    assert.equal((await writes()).length, 1);
    assert.equal(await page.getByTestId("git-integration-continue").isDisabled(), true);
    await resolve("merged\n");
    await page.getByTestId("git-integration-continue").click();
    await page.getByTestId("git-integration-confirm").click();
    await page.getByTestId("git-integration-start").waitFor();
    const mutations = await writes(),
      source = mutations.find((call) => call.method === "startIntegration").params.requestId;
    assert.ok(
      mutations
        .filter((call) => call.method !== "startIntegration")
        .every((call) => call.params.sourceRequestId === source),
    );
    assert.equal(mutations.filter((call) => call.method === "continueIntegration").length, 1);
  });
  await t.test("Rebase 两轮解决分别继续，保持原 sourceRequestId", async () => {
    await go();
    await start("rebase");
    await resolve("first\n");
    await page.getByTestId("git-integration-continue").click();
    await page.getByTestId("git-integration-confirm").click();
    await page.getByTestId("git-integration-resolve").waitFor();
    await resolve("second\n");
    await page.getByTestId("git-integration-continue").click();
    await page.getByTestId("git-integration-confirm").click();
    await page.getByTestId("git-integration-start").waitFor();
    const commands = (await writes()).filter((call) => call.method === "continueIntegration");
    assert.equal(commands.length, 2);
    assert.equal(commands[0].params.sourceRequestId, commands[1].params.sourceRequestId);
    assert.notEqual(commands[0].params.requestId, commands[1].params.requestId);
  });
  await t.test("中止警示必须勾选；预览后实际 revision 变化拒绝执行", async () => {
    await go();
    await start();
    await page.getByTestId("git-integration-abort").click();
    const button = page.getByTestId("git-integration-confirm");
    assert.equal(await button.isDisabled(), true);
    await page.getByTestId("git-integration-discard-check").check();
    await control("externalChange");
    await button.click();
    await page.getByTestId("git-integration-active").waitFor();
    assert.match(await page.getByTestId("git-workspace-receipt").innerText(), /已变化|过期/);
    await page.getByTestId("git-integration-abort").click();
    await page.getByTestId("git-integration-discard-check").check();
    await button.click();
    await page.getByTestId("git-integration-start").waitFor();
    assert.equal(
      (await writes()).filter((call) => call.method === "abortIntegration").at(-1).params
        .confirmDiscard,
      true,
    );
  });
  await t.test("丢回执只读恢复，切换页面不重复发起", async () => {
    await go();
    await control("lostAck");
    await start();
    assert.equal(
      await page.getByTestId("git-workspace-error").innerText(),
      "未收到明确结果，请查询原请求，勿重复执行。",
    );
    await page.getByTestId("git-view-changes").click();
    await page.getByTestId("git-view-integration").click();
    await page.getByTestId("git-integration-active").waitFor();
    assert.equal((await writes()).filter((call) => call.method === "startIntegration").length, 1);
  });
  await t.test("Host 切换丢弃旧预览，远端写入保留 identity", async () => {
    await go();
    await control("hold");
    await page.getByTestId("git-integration-target").fill("refs/heads/topic");
    await page.getByTestId("git-integration-start").click();
    await page.waitForFunction(() =>
      globalThis.__gitIntegration.calls.some((call) => call.method === "preview"),
    );
    await control("remote");
    await control("release");
    await page.waitForFunction(() =>
      globalThis.__gitIntegration.calls.some(
        (call) => call.host === "remote" && call.method === "snapshot",
      ),
    );
    assert.equal(await page.getByTestId("git-integration-confirmation").count(), 0);
    await start();
    const mutation = (await writes())[0];
    assert.equal(mutation.host, "remote");
    assert.equal(mutation.params.workspaceIdentity, "fixture:remote");
  });
  await t.test("外部整合无继续/中止入口，未知原生进程需要单独确认", async () => {
    await go("?external");
    assert.equal(await page.getByTestId("git-integration-start").isDisabled(), true);
    assert.equal(await page.getByTestId("git-integration-abort").count(), 0);
    await go("?unknown");
    await start();
    await page.getByTestId("git-integration-abort").click();
    await page.getByTestId("git-integration-discard-check").check();
    assert.equal(await page.getByTestId("git-integration-confirm").isDisabled(), true);
    await page.getByTestId("git-integration-confirmation").getByRole("checkbox").last().check();
    assert.equal(await page.getByTestId("git-integration-confirm").isDisabled(), false);
  });
  await t.test("390px 英文暗色与中文亮色保持布局、键盘和输入字体", async () => {
    await mkdir("../../artifacts/git-integration", { recursive: true });
    for (const english of [false, true]) {
      await page.setViewportSize({ width: 390, height: 844 });
      await go(english ? "?english&dark" : "");
      const input = page.getByTestId("git-integration-target");
      await input.focus();
      assert.ok(
        await input.evaluate((element) => parseFloat(getComputedStyle(element).fontSize) >= 16),
      );
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await start();
      await page.getByTestId("git-integration-abort").click();
      await page.screenshot({
        path: `../../artifacts/git-integration/${english ? "english-dark" : "chinese-light"}.png`,
      });
      await page.getByTestId("git-integration-discard-check").focus();
      await page.keyboard.press("Space");
      assert.equal(await page.getByTestId("git-integration-confirm").isEnabled(), true);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  });
}
