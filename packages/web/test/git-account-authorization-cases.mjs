import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

export async function runGitAccountAuthorizationCases({ t, page, base, fill, snapshot }) {
  await t.test("自建证书与应用配置错误显示固定明细，失败授权不能保存", async () => {
    await page.goto(base + "?management");
    await page.getByRole("tab", { name: "GitLab 账号", exact: true }).click();
    await page.getByRole("button", { name: "添加账号", exact: true }).click();
    await page.getByRole("combobox", { name: "认证方式", exact: true }).selectOption("oauth");
    await page
      .getByRole("textbox", { name: "OAuth Client ID", exact: true })
      .fill("fixture-client");
    const panel = page.getByTestId("git-account-authorization");
    for (const [code, message] of [
      ["oauth-tls-untrusted", /系统信任库/],
      ["oauth-client-invalid", /Client ID 无效/],
    ]) {
      await page.getByRole("button", { name: "开始授权登录", exact: true }).click();
      await page.evaluate(
        (code) => globalThis.__gitWorkspace.management.failAuthorization(code),
        code,
      );
      await panel.getByRole("alert").filter({ hasText: message }).waitFor();
      assert.equal(
        await panel.getByRole("button", { name: "打开授权页面", exact: true }).count(),
        0,
      );
      assert.equal(
        await page.getByRole("button", { name: "保存账号", exact: true }).isDisabled(),
        true,
      );
    }
    assert.equal((await snapshot()).accounts.length, 0);
    assert.ok(!(await panel.textContent()).includes("UNABLE_TO_VERIFY_LEAF_SIGNATURE"));
  });
  await t.test("浏览器授权入口及问号帮助覆盖 GitHub、GitLab、自建 Gitea/Forgejo", async () => {
    await mkdir("artifacts/git-account-discovery", { recursive: true });
    for (const [tab, server, guide] of [
      ["GitHub 账号", "https://github.com", "Device Flow"],
      ["GitLab 账号", "https://code.example.invalid", "非机密"],
      ["Gitea / Forgejo 账号", "https://forge.example.invalid", "PKCE"],
    ]) {
      await page.setViewportSize({ width: 1280, height: 1000 });
      await page.goto(base + "?management");
      await page.getByRole("tab", { name: tab, exact: true }).click();
      await page.getByRole("button", { name: "添加账号", exact: true }).click();
      await fill("账号名称", "授权账号");
      await fill("服务器地址", server);
      await page.getByRole("combobox", { name: "认证方式", exact: true }).selectOption("oauth");
      const panel = page.getByTestId("git-account-authorization"),
        help = page.getByRole("button", { name: "如何授权登录？", exact: true });
      await help.hover();
      await page.getByTestId("git-oauth-help").waitFor();
      assert.ok((await page.getByTestId("git-oauth-help").textContent()).includes(guide));
      await page.keyboard.press("Escape");
      await page.getByTestId("git-oauth-help").waitFor({ state: "detached" });
      await page
        .getByRole("textbox", { name: "OAuth Client ID", exact: true })
        .fill("fixture-client");
      await help.focus();
      await page.getByTestId("git-oauth-help").waitFor();
      await page.keyboard.press("Escape");
      assert.equal(
        await page.getByRole("button", { name: "保存账号", exact: true }).isDisabled(),
        true,
      );
      await panel.getByRole("button", { name: "开始授权登录", exact: true }).click();
      await panel
        .getByRole("status")
        .getByText(/等待浏览器授权/)
        .waitFor();
      if (tab === "GitHub 账号") assert.ok((await panel.textContent()).includes("ABCD-EFGH"));
      await page.evaluate(() => globalThis.__gitWorkspace.management.completeAuthorization());
      await panel
        .getByRole("status")
        .getByText(/已授权，请保存账号/)
        .waitFor();
      assert.equal(
        await page.getByRole("textbox", { name: "用户名", exact: true }).inputValue(),
        "authorized-fixture",
      );
      assert.ok(!(await panel.textContent()).includes("access_token"));
      await page.getByRole("button", { name: "保存账号", exact: true }).click();
      await page.getByTestId("git-account-editor").waitFor({ state: "detached" });
      assert.equal((await snapshot()).accounts[0].auth, "oauth");
      assert.equal((await snapshot()).accounts[0].username, "authorized-fixture");
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base + "?management&dark");
    await page.getByRole("button", { name: "添加账号", exact: true }).click();
    await page.getByRole("combobox", { name: "认证方式", exact: true }).selectOption("oauth");
    await page.getByRole("button", { name: "如何授权登录？", exact: true }).click();
    await page.getByTestId("git-oauth-help").waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({
      path: "artifacts/git-account-discovery/oauth-help-mobile.png",
      fullPage: true,
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await page
      .getByRole("textbox", { name: "OAuth Client ID", exact: true })
      .fill("fixture-client");
    await page.getByRole("button", { name: "开始授权登录", exact: true }).click();
    await page.getByRole("button", { name: "取消授权", exact: true }).click();
    assert.equal((await snapshot()).accounts.length, 0);
    await page
      .getByTestId("git-system-credential-source")
      .getByText(/Windows 凭据管理器/)
      .waitFor();
  });
}
