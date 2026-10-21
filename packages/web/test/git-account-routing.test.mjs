import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test("项目向导可直接选用检测账号，无须先打开设置导入", { timeout: 90000 }, async (t) => {
  const { browser, port } = await startWorkflowProgressBrowser(t),
    page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  await page.goto(`http://127.0.0.1:${port}/test/fixtures/git-workspace.html`);
  await page.getByTestId("composer-workspace-trigger").click();
  await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
  await page.getByRole("textbox", { name: "项目名称", exact: true }).fill("直接使用检测账号");
  await page.getByTestId("project-git-repository").click();
  await page.getByTestId("git-repository-next").click();
  await page.getByRole("textbox", { name: "目录路径", exact: true }).fill("/fixture/import");
  await page.getByTestId("git-repository-next").click();
  await page
    .getByRole("textbox", { name: "仓库地址", exact: true })
    .fill("https://github.com/fixture/repo.git");
  await page.getByRole("textbox", { name: "新目录名称", exact: true }).fill("selected");
  const select = page.getByTestId("git-repository-account");
  await select.locator('option[value="detected:gcm-bob"]').waitFor({ state: "attached" });
  await select.selectOption("detected:gcm-bob");
  await page.waitForFunction(() =>
    globalThis.__gitWorkspace.management.snapshot().accounts.some((a) => a.username === "bob"),
  );
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="git-repository-account"]')?.value.includes('"id"'),
  );
  await page.getByTestId("git-repository-next").click();
  await page.getByTestId("git-import-confirm").click();
  await page.getByTestId("git-repository-wizard").waitFor({ state: "detached" });
  const result = await page.evaluate(() => ({
    calls: globalThis.__gitWorkspace.calls,
    profile: globalThis.__gitWorkspace.management.snapshot(),
  }));
  const command = result.calls.find((c) => c.method === "acquireRepository");
  assert.equal(command.params.options.authentication.id, result.profile.accounts[0].id);
  assert.equal(result.profile.accounts[0].username, "bob");
  assert.equal(result.profile.accounts[0].hasToken, false);
  assert.ok(!JSON.stringify(command).includes('"token"'));
});

test("远端账号直接选用、按 URL 保存和迟到响应隔离", { timeout: 120000 }, async (t) => {
  const { browser, port } = await startWorkflowProgressBrowser(t),
    page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const base = `http://127.0.0.1:${port}/test/fixtures/git-workspace.html?authentication`;
  await page.goto(base);
  const select = page
    .getByRole("combobox")
    .filter({ has: page.locator('option[value="detected:gcm-bob"]') })
    .first();
  await select.selectOption("detected:gcm-bob");
  await page.waitForFunction(() =>
    globalThis.__gitWorkspace.management.snapshot().accounts.some((a) => a.username === "bob"),
  );
  await page.waitForFunction(() =>
    document
      .querySelector('[data-testid="git-remote-authentication"] select')
      ?.value.startsWith("saved:"),
  );
  const saved = await page
    .locator('[data-testid="git-remote-authentication"] select')
    .first()
    .inputValue();
  const controls = page.locator('[data-testid="git-remote-authentication"] select');
  assert.equal(await controls.nth(1).inputValue(), "");
  const authSection = page.getByTestId("git-remote-authentication");
  const beforeRefresh = await authSection.boundingBox();
  const beforeCount = await controls.count();
  const previousReads = await page.evaluate(
    () =>
      globalThis.__gitWorkspace.management.routingCalls().filter((c) => c.type === "get").length,
  );
  await page.evaluate(() => globalThis.__gitWorkspace.management.holdNextAuthentication());
  await authSection.getByRole("button", { name: "重新读取", exact: true }).click();
  await page.waitForFunction(
    (n) =>
      globalThis.__gitWorkspace.management.routingCalls().filter((c) => c.type === "get").length >
      n,
    previousReads,
  );
  assert.equal(await controls.count(), beforeCount, "刷新不得移除已有远端表单");
  assert.equal(await controls.first().isDisabled(), true);
  const duringRefresh = await authSection.boundingBox();
  assert.equal(duringRefresh.height, beforeRefresh.height);
  await page.evaluate(() => globalThis.__gitWorkspace.management.releaseAuthentication());
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="git-remote-authentication"] select')?.disabled ===
      false,
  );
  await page.evaluate(() => globalThis.__gitWorkspace.authenticationPath("/fixture/repo-B"));
  await page.waitForFunction(
    () => document.querySelector('[data-testid="git-remote-authentication"] select')?.value === "",
  );
  await controls.first().selectOption({ label: "bob · github.com · bob" });
  await page.waitForFunction(() =>
    document
      .querySelector('[data-testid="git-remote-authentication"] select')
      ?.value.startsWith("saved:"),
  );
  await page.evaluate(() => {
    globalThis.__gitWorkspace.management.holdNextAuthentication();
    globalThis.__gitWorkspace.authenticationPath("/fixture/repo");
  });
  await page.waitForFunction(
    () =>
      globalThis.__gitWorkspace.management
        .routingCalls()
        .filter((c) => c.type === "get" && c.workspacePath === "/fixture/repo").length >= 3,
  );
  await page.evaluate(() => globalThis.__gitWorkspace.authenticationPath("/fixture/repo-C"));
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="git-remote-authentication"] select')?.value === "" &&
      !document.querySelector('[data-testid="git-remote-authentication"] select')?.disabled,
  );
  await page.evaluate(() => globalThis.__gitWorkspace.management.releaseAuthentication());
  assert.equal(await controls.first().inputValue(), "");
  await page.evaluate(() => globalThis.__gitWorkspace.authenticationPath("/fixture/repo"));
  await page.waitForFunction(
    (expected) =>
      document.querySelector('[data-testid="git-remote-authentication"] select')?.value ===
      expected,
    saved,
  );
  assert.equal(errors.length, 0);
  await mkdir("artifacts/git-account-routing-investigation", { recursive: true });
  for (const query of ["", "&dark&english"]) {
    await page.goto(base + query);
    await page.getByTestId("git-remote-authentication").getByRole("combobox").first().waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: `artifacts/git-account-routing-investigation/remote-${query ? "dark-english" : "light"}.png`,
    });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.goto(base);
  await page.getByTestId("git-remote-authentication").waitFor();
  await page.evaluate(() => globalThis.__gitWorkspace.remote());
  await page.getByTestId("git-remote-authentication").waitFor({ state: "hidden" });
  assert.equal(errors.length, 0);
});
