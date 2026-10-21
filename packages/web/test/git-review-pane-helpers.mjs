import assert from "node:assert/strict";

export async function showReviewFiles(page, manageRange = false) {
  await page.getByTestId("git-view-review").click();
  const files = page.getByTestId("git-review-show-files");
  if (await files.isVisible()) await files.click();
  if (manageRange) {
    const manage = page.getByTestId("git-review-manage-range");
    if ((await manage.isVisible()) && (await manage.getAttribute("aria-pressed")) === "false")
      await manage.click();
  }
  await page.getByTestId("review-file-workspace").waitFor();
}

export async function returnToReview(page) {
  // 合并候选等独立预览仍有返回导航；来源范围/Diff 已在同页，直接检查原页面。
  const back = page.getByTestId("code-viewer-return-review");
  if (await back.isVisible()) await back.click();
  if (!(await page.getByTestId("git-commit-review-pane").isVisible()))
    await page.getByTestId("git-view-review").click();
  assert.equal(await page.getByTestId("git-commit-review-pane").isVisible(), true);
}

export async function openRemotePublication(page) {
  await page.getByTestId("git-view-network").click();
  await page.getByTestId("git-network-publication-host").waitFor();
}
