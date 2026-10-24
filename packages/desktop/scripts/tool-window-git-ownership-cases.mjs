import assert from "node:assert/strict";

export async function assertSameProjectGitIsolation(page, popup, closePopup) {
  const originalGit = await page.evaluate(() => window.toolOwnerFixture.currentTab());
  await page.evaluate(() => window.toolOwnerFixture.switch("/fixture/repo", "chat-a2"));
  await page.getByTestId("active-owner").getByText("Project A · chat-a2").waitFor();
  await page.getByRole("button", { name: "Open Git", exact: true }).click();
  await page.getByTestId("git-view-review").click();
  await page.getByTestId("git-commit-message-input").fill("Project A2 draft");
  const secondGit = await page.evaluate(() => window.toolOwnerFixture.currentTab());
  assert.notEqual(secondGit, originalGit);
  assert.equal(await popup.getByTestId("tool-window-owner").innerText(), "Project A · chat-a");
  assert.equal(await popup.getByTestId("git-commit-message-input").inputValue(), "Project A draft");
  await popup.getByTestId("git-view-changes").click();
  assert.equal(await popup.getByTestId("git-view-changes").getAttribute("aria-current"), "page");
  await popup.getByTestId("git-view-review").click();
  assert.equal(await popup.getByTestId("git-commit-message-input").inputValue(), "Project A draft");
  assert.equal(await page.getByTestId("git-commit-message-input").inputValue(), "Project A2 draft");
  await closePopup(popup, popup.getByRole("button", { name: "关闭标签", exact: true }));
  assert.deepEqual(
    await page.evaluate(
      ([a, b]) => [
        window.toolOwnerFixture.hasTab("/fixture/repo", a),
        window.toolOwnerFixture.hasTab("/fixture/repo", b),
        window.toolOwnerFixture.currentTab(),
      ],
      [originalGit, secondGit],
    ),
    [false, true, secondGit],
  );
  await page
    .getByRole("button", { name: "在独立窗口中打开", exact: true })
    .waitFor({ state: "visible" });
}

export async function assertReviewDock(page, electron, watch) {
  await page.evaluate(() => window.toolOwnerFixture.switch("/fixture/repo", "chat-dock"));
  await page.getByTestId("active-owner").getByText("Project A · chat-dock").waitFor();
  await page.getByRole("button", { name: "Open Git", exact: true }).click();
  await page.getByTestId("git-view-review").click();
  await page.getByTestId("git-commit-message-input").fill("Review survives docking");
  const opened = electron.waitForEvent("window");
  await page.getByRole("button", { name: "在独立窗口中打开", exact: true }).click();
  const popup = await opened;
  watch(popup);
  await popup.getByTestId("tool-window-owner").waitFor();
  await page.evaluate(() => window.toolOwnerFixture.switch("/fixture/project-b", "chat-b"));
  await page.getByTestId("active-owner").getByText("Project B · chat-b").waitFor();
  assert.equal(
    await popup.getByTestId("git-commit-message-input").inputValue(),
    "Review survives docking",
  );
  const closed = popup.waitForEvent("close");
  await Promise.all([
    closed,
    popup
      .getByRole("button", { name: "放回右侧", exact: true })
      .click()
      .catch((error) => {
        if (!popup.isClosed()) throw error;
      }),
  ]);
  await page.getByTestId("active-owner").getByText("Project A · chat-dock").waitFor();
  assert.equal(
    await page.getByTestId("git-commit-message-input").inputValue(),
    "Review survives docking",
  );
  assert.equal(await page.getByTestId("git-commit-message-input").count(), 1);
}
