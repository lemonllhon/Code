import assert from "node:assert/strict";
import { resolve } from "node:path";

export async function runWallpaperColorChecks({ page, dialog, searches, artifacts }) {
  const color = dialog.getByRole("button", { name: "颜色", exact: true });
  const people = await dialog.getByRole("button", { name: "人物", exact: true }).boundingBox();
  assert.ok((await color.boundingBox()).x > people.x, "颜色入口位于人物之后");
  assert.equal(searches.at(-1).color, "999999");
  const responseFor = (hex, pageNumber = "1") =>
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.hostname === "wallpaper-market.test" &&
        url.pathname === "/search" &&
        url.searchParams.get("color") === hex &&
        url.searchParams.get("page") === pageNumber
      );
    });
  await color.click();
  assert.equal(
    await page.getByRole("group", { name: "壁纸颜色色卡" }).getByRole("button").count(),
    29,
  );
  const manual = responseFor("0099cc");
  await page.getByRole("button", { name: "颜色 #0099cc", exact: true }).click();
  await manual;
  const next = responseFor("0099cc", "2");
  await dialog.getByRole("button", { name: "下一页", exact: true }).click();
  await next;
  assert.equal(searches.at(-1).color, "0099cc");
  await page.emulateMedia({ colorScheme: "dark" });
  assert.match(await color.innerText(), /#0099cc/);
  await color.click();
  const any = responseFor("");
  await page.getByRole("button", { name: "不限颜色", exact: true }).click();
  await any;
  assert.equal(searches.at(-1).page, "1");
  await color.click();
  const recommended = responseFor("424153");
  await page.getByRole("button", { name: "跟随主题：暗夜黑", exact: true }).click();
  await recommended;
  const darkNext = responseFor("424153", "2");
  await dialog.getByRole("button", { name: "下一页", exact: true }).click();
  await darkNext;
  const changedAt = searches.length;
  const light = responseFor("999999");
  await page.emulateMedia({ colorScheme: "light" });
  await light;
  assert.equal(searches.slice(changedAt).find((query) => query.color === "999999").page, "1");
  await color.click();
  await page.waitForFunction(() => {
    const popup = document.querySelector('[data-slot="popover-content"]');
    return popup && Number(getComputedStyle(popup).opacity) >= 0.999;
  });
  await page.screenshot({ path: resolve(artifacts, "wallpaper-market-colors.png") });
  await page.keyboard.press("Escape");
}
