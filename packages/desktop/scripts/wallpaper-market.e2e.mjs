import assert from "node:assert/strict";
import { resolve } from "node:path";
import { runWallpaperColorChecks } from "./wallpaper-colors.e2e.mjs";

export async function runWallpaperMarketTests({ t, page, artifacts }) {
  await t.test(
    "wallpaper market search, retry, apply, fill modes and appearance persistence",
    async () => {
      const png = Buffer.from(
        await page.evaluate(() => {
          const canvas = document.createElement("canvas");
          canvas.width = 64;
          canvas.height = 32;
          const context = canvas.getContext("2d");
          context.fillStyle = "#2f785b";
          context.fillRect(0, 0, 64, 32);
          context.fillStyle = "#c68b48";
          context.fillRect(32, 0, 32, 32);
          return canvas.toDataURL().split(",")[1];
        }),
        "base64",
      );
      let failSearch = false,
        failDownload = false,
        releaseSlow,
        slowStarted;
      const slowRequest = new Promise((resolve) => {
        slowStarted = resolve;
      });
      const searches = [];
      const route = async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/image") {
          if (failDownload && url.searchParams.get("thumbnail") === "false")
            return route.fulfill({ status: 503, body: "offline" });
          const large =
            url.searchParams.get("url")?.includes("big123") &&
            url.searchParams.get("thumbnail") === "false";
          return route.fulfill({
            contentType: "image/png",
            body: large ? Buffer.concat([png, Buffer.alloc(11 * 1024 * 1024)]) : png,
          });
        }
        searches.push(Object.fromEntries(url.searchParams));
        if (failSearch) return route.fulfill({ status: 503, body: "offline" });
        const query = url.searchParams.get("query");
        if (query === "slow" && url.searchParams.get("category") === "all") {
          slowStarted();
          await new Promise((resolve) => {
            releaseSlow = resolve;
          });
        }
        const pageNumber = Number(url.searchParams.get("page"));
        const id =
          pageNumber === 2
            ? "def456"
            : query === "slow" && url.searchParams.get("category") === "all"
              ? "slow123"
              : "abc123";
        const item = {
          id,
          thumbUrl: `https://th.wallhaven.cc/small/ab/${id}.jpg`,
          fullUrl: `https://w.wallhaven.cc/full/ab/${id}.png`,
          sourceUrl: `https://wallhaven.cc/w/${id}`,
          width: 1920,
          height: 1080,
          fileSize: 2048,
        };
        return route.fulfill({
          json: {
            items:
              query === "empty"
                ? []
                : [
                    item,
                    {
                      ...item,
                      id: "big123",
                      fullUrl: "https://w.wallhaven.cc/full/bi/big123.png",
                      width: 8000,
                      height: 6000,
                      fileSize: 11 * 1024 * 1024,
                    },
                  ],
            page: pageNumber,
            lastPage: 2,
          },
        });
      };
      await page.route("https://wallpaper-market.test/**", route);
      try {
        const openMarket = () =>
          page.getByRole("button", { name: "壁纸市场", exact: true }).click();
        await page.emulateMedia({ colorScheme: "light" });
        await openMarket();
        const dialog = page.getByTestId("wallpaper-market");
        const card = () => dialog.getByTestId("wallpaper-market-abc123");
        await card().waitFor();
        await runWallpaperColorChecks({ page, dialog, searches, artifacts });
        assert.equal(await dialog.getByTestId("wallpaper-market-big123").isDisabled(), false);
        assert.equal(await dialog.getByText(/超出上限/).count(), 0);
        await dialog.getByTestId("wallpaper-market-big123").click();
        await dialog.getByText("已下载壁纸：big123", { exact: true }).waitFor();
        await dialog.getByText("使用中", { exact: true }).waitFor();
        await dialog.getByRole("button", { name: "下一页", exact: true }).click();
        await dialog.getByTestId("wallpaper-market-def456").waitFor();
        await dialog.getByRole("button", { name: "风景", exact: true }).click();
        await card().waitFor();
        assert.equal(searches.at(-1).category, "general");
        assert.equal(searches.at(-1).page, "1");
        const search = dialog.getByRole("textbox", { name: "搜索壁纸…" });
        await search.fill("empty");
        await search.press("Enter");
        await dialog.getByText("没有找到匹配的壁纸。", { exact: true }).waitFor();
        await search.fill("");
        await search.press("Enter");
        await card().waitFor();
        failSearch = true;
        await dialog.getByRole("button", { name: "刷新", exact: true }).click();
        await dialog.getByText("壁纸市场加载失败。", { exact: true }).waitFor();
        failSearch = false;
        await dialog.getByRole("button", { name: "重试", exact: true }).click();
        await card().waitFor();
        await dialog.getByRole("button", { name: "全部", exact: true }).click();
        await card().waitFor();
        await search.fill("slow");
        await search.press("Enter");
        await slowRequest;
        await dialog.getByRole("button", { name: "二次元", exact: true }).click();
        await card().waitFor();
        releaseSlow();
        failDownload = true;
        await card().click();
        await dialog
          .getByText("下载或应用失败，请检查网络、图片格式与本机存储后重试。", { exact: true })
          .waitFor();
        await dialog.getByText("已下载壁纸：big123", { exact: true }).waitFor();
        failDownload = false;
        await card().click();
        await dialog.getByText("使用中", { exact: true }).waitFor();
        assert.equal(await dialog.getByTestId("wallpaper-market-slow123").count(), 0);
        await page.screenshot({ path: resolve(artifacts, "wallpaper-market.png") });
        await dialog.getByRole("button", { name: "关闭", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        const setRange = async (name, value) => {
          await page.getByRole("slider", { name, exact: true }).evaluate((element, value) => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(
              element,
              String(value),
            );
            element.dispatchEvent(new Event("input", { bubbles: true }));
            element.dispatchEvent(new Event("change", { bubbles: true }));
          }, value);
          await page.waitForFunction(
            ({ name, value }) =>
              document.querySelector(`input[aria-label="${name}"]`)?.value === String(value),
            { name, value },
          );
        };
        await setRange("遮罩不透明度", 40);
        await setRange("图片模糊", 8);
        await setRange("面板不透明度", 30);
        for (const [name, size, repeat] of [
          ["覆盖", "cover", "no-repeat"],
          ["适应", "contain", "no-repeat"],
          ["居中", "auto", "no-repeat"],
          ["平铺", "auto", "repeat"],
        ]) {
          await page.getByRole("combobox", { name: "填充方式", exact: true }).click();
          await page.getByRole("option", { name, exact: true }).click();
          await page.getByRole("button", { name: "返回项目", exact: true }).click();
          await page.waitForFunction(() =>
            Boolean(document.querySelector("[data-wallpaper-active=true]")),
          );
          assert.deepEqual(
            await page
              .getByTestId("wallpaper-static")
              .evaluate((element) => [
                element.style.backgroundSize,
                element.style.backgroundRepeat,
              ]),
            [size, repeat],
          );
          assert.equal(
            await page
              .getByTestId("wallpaper-media")
              .evaluate((element) => getComputedStyle(element).filter),
            "blur(8px)",
          );
          assert.equal(
            await page
              .locator("[data-wallpaper-tint]")
              .evaluate((element) => getComputedStyle(element).opacity),
            "0.4",
          );
          assert.match(
            await page
              .getByTestId("wallpaper-panel-probe")
              .evaluate((element) => getComputedStyle(element).backgroundColor),
            /0\.3/,
          );
          assert.match(
            await page
              .locator("[data-workspace-conversation-frame]")
              .evaluate((element) => getComputedStyle(element).backgroundColor),
            /0\.3/,
          );
          assert.equal(
            await page
              .locator("[data-workspace-conversation-frame] main")
              .evaluate((element) => getComputedStyle(element).backgroundColor),
            "rgba(0, 0, 0, 0)",
          );
          await page.getByRole("button", { name: "打开外观设置", exact: true }).click();
        }
        await page.reload();
        await page.getByRole("combobox", { name: "填充方式", exact: true }).waitFor();
        assert.match(
          await page.getByRole("combobox", { name: "填充方式", exact: true }).innerText(),
          /平铺/,
        );
        assert.equal(
          await page.getByRole("slider", { name: "图片模糊", exact: true }).inputValue(),
          "8",
        );
        await openMarket();
        await dialog.getByText("使用中", { exact: true }).waitFor();
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(
          await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
          true,
        );
        await page.screenshot({ path: resolve(artifacts, "wallpaper-market-narrow.png") });
        await dialog.getByRole("button", { name: "关闭", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        assert.equal(
          await page
            .getByTestId("wallpaper-settings")
            .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
          true,
        );
        await page
          .getByRole("slider", { name: "面板不透明度", exact: true })
          .scrollIntoViewIfNeeded();
        await page.screenshot({
          path: resolve(artifacts, "wallpaper-settings-narrow.png"),
          fullPage: true,
        });
        await page.setViewportSize({ width: 1200, height: 800 });
        await page.getByRole("button", { name: "返回项目", exact: true }).click();
        for (const dark of [false, true]) {
          await page.evaluate(
            (dark) => document.documentElement.classList.toggle("dark", dark),
            dark,
          );
          await page.screenshot({
            path: resolve(artifacts, `wallpaper-project-${dark ? "dark" : "light"}.png`),
          });
        }
        await page.getByRole("button", { name: "打开外观设置", exact: true }).click();
        await openMarket();
        await dialog.getByText("已下载壁纸：abc123", { exact: true }).waitFor();
        await dialog.getByRole("button", { name: "删除已下载壁纸", exact: true }).click();
        await dialog
          .getByRole("button", { name: "删除已下载壁纸", exact: true })
          .waitFor({ state: "hidden" });
        assert.equal(await dialog.getByText("使用中", { exact: true }).count(), 0);
        await dialog.getByRole("button", { name: "关闭", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        await page.getByRole("button", { name: "返回项目", exact: true }).click();
        await page.waitForFunction(() => !document.querySelector("[data-testid=wallpaper-image]"));
        await page.getByRole("button", { name: "打开外观设置", exact: true }).click();
        await page.reload();
        await page.getByRole("combobox", { name: "壁纸选择", exact: true }).waitFor();
        assert.match(
          await page.getByRole("combobox", { name: "壁纸选择", exact: true }).innerText(),
          /关闭/,
        );
        assert.equal(
          await page.getByRole("slider", { name: "图片模糊", exact: true }).inputValue(),
          "8",
        );
        await openMarket();
        await card().waitFor();
        assert.equal(
          await dialog.getByRole("button", { name: "删除已下载壁纸", exact: true }).count(),
          0,
        );
        assert.equal(await card().isDisabled(), false);
        await page.screenshot({ path: resolve(artifacts, "wallpaper-market-deleted.png") });
        await dialog.getByRole("button", { name: "关闭", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
      } finally {
        releaseSlow?.();
        await page.unroute("https://wallpaper-market.test/**", route);
      }
    },
  );
}
