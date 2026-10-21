import assert from "node:assert/strict";
export async function runGitSystemAccountCases({ t, page, base, snapshot }) {
  await t.test(
    "系统凭据多账号覆盖 GitLab、自建实例、Forgejo、Bitbucket，来源不可用仍保留账号",
    async () => {
      await page.setViewportSize({ width: 1280, height: 1000 });
      await page.goto(base + "?management&systems");
      for (const [tab, count] of [
        ["GitLab 账号", 3],
        ["Gitea / Forgejo 账号", 2],
        ["Git 服务器账号", 3],
      ]) {
        await page.getByRole("tab", { name: tab, exact: true }).click();
        assert.equal(await page.getByTestId("git-detected-account").count(), count);
      }
      await page.getByRole("tab", { name: "GitLab 账号", exact: true }).click();
      await page
        .getByTestId("git-detected-account")
        .filter({ hasText: "lab-second" })
        .getByRole("button", { name: "导入", exact: true })
        .click();
      await page.getByRole("button", { name: "修改 lab-second", exact: true }).waitFor();
      assert.equal((await snapshot()).accounts[0].username, "lab-second");
      assert.equal((await snapshot()).accounts[0].auth, "system");
      await page.evaluate(() => globalThis.__gitWorkspace.management.systemUnavailable());
      await page.getByRole("button", { name: "检测本机账号", exact: true }).click();
      await page
        .getByTestId("git-system-credential-source")
        .getByText(/当前不可访问/)
        .waitFor();
      assert.equal((await snapshot()).accounts.length, 1);
      assert.equal(await page.getByTestId("git-detected-account").count(), 1);
    },
  );
}
