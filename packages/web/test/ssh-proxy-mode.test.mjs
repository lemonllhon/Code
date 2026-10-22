import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "SSH proxy mode selects a local Settings profile without a separate switch or credential inputs",
  { timeout: 120_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    await mkdir(new URL("../../../.artifacts/ssh-proxy-mode/", import.meta.url), {
      recursive: true,
    });
    for (const width of [1280, 390])
      for (const locale of ["en", "zh"]) {
        await t.test(`${width}px ${locale}`, async () => {
          const page = await browser.newPage({
            viewport: { width, height: width === 1280 ? 720 : 844 },
          });
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          try {
            await page.goto(
              `http://127.0.0.1:${port}/test/fixtures/remote-connection.html?lang=${locale}`,
            );
            if (locale === "zh")
              await page.evaluate(() =>
                document.documentElement.classList.add("dark", "theme-zai-dark"),
              );
            await page.getByTestId("ssh-connect-trigger").click();
            const selection = page.getByTestId("ssh-proxy-mode");
            await selection.waitFor();
            assert.equal(await page.getByRole("switch").count(), 0);
            await selection.click();
            await page.getByRole("option", { name: /Office HTTP/ }).click();
            await selection.click();
            await page.getByRole("option", { name: /Home SOCKS5/ }).click();
            await selection.press("Space");
            await page.getByRole("option", { name: /Office HTTP/ }).click();
            assert.equal(
              await page
                .getByText(
                  locale === "zh"
                    ? "选择设置中已保存的代理，自动复用地址及账号密码。"
                    : "Select a saved proxy from Settings to reuse its address and credentials.",
                  { exact: true },
                )
                .count(),
              0,
            );
            assert.equal(await selection.getAttribute("aria-describedby"), null);
            const resources = page.getByRole("group", {
              name: locale === "zh" ? "资源下载方式" : "Resource download method",
              exact: true,
            });
            await resources.scrollIntoViewIfNeeded();
            const aliasControl = page.getByTestId("ssh-config-alias-select");
            const alias = await aliasControl.boundingBox();
            const resourceBox = await resources.boundingBox();
            assert.ok(alias && resourceBox);
            assert.ok(alias.width <= 224, "alias field stays compact");
            if (width === 1280) {
              assert.ok(Math.abs(resourceBox.y - alias.y) <= 1, "top controls share one row");
              const aliasLabel = await aliasControl.locator("..").locator("label").boundingBox();
              const resourceLabel = await resources.locator("..").locator("label").boundingBox();
              assert.ok(aliasLabel && resourceLabel);
              assert.ok(Math.abs(aliasLabel.y - resourceLabel.y) <= 1, "top labels align");
              assert.ok(resourceBox.x >= alias.x + alias.width, "download choice follows alias");
            } else assert.ok(resourceBox.y > alias.y, "narrow screens stack the top fields");
            const host = await page.getByTestId("ssh-host-input").boundingBox();
            assert.ok(
              host && host.y > resourceBox.y + resourceBox.height,
              "top fields precede host",
            );
            const portInput = await page.getByTestId("ssh-port-input").boundingBox();
            assert.ok(host && portInput);
            assert.ok(Math.abs(host.y - portInput.y) <= 1, "host and port stay in one row");
            assert.ok(portInput.width <= 88, "port uses a compact five-digit column");
            const scroll = page.getByTestId("remote-connection-settings-scroll");
            const scrollBox = await scroll.boundingBox();
            // Chromium 的滚动位置取整，实测顶部与底部分别可能有 0.5px / 0.75px 舍入差。
            assert.ok(scrollBox && resourceBox.y >= scrollBox.y - 1);
            assert.ok(resourceBox.y + resourceBox.height <= scrollBox.y + scrollBox.height + 1);
            await resources.getByRole("button").nth(1).click();
            assert.equal(await page.locator('input[type="password"]').count(), 1);
            assert.equal(
              (await page.locator("body").innerText()).includes("fixture-secret"),
              false,
            );
            await page.getByTestId("ssh-host-input").fill("fixture.invalid");
            await page.getByTestId("ssh-username-input").fill("fixture");
            await page.getByTestId("ssh-password-input").fill("fixture-password");
            await selection.scrollIntoViewIfNeeded();
            assert.ok(
              await page
                .getByTestId("ssh-dialog")
                .evaluate((el) => el.scrollWidth <= el.clientWidth + 2),
            );
            await page.screenshot({
              path: fileURLToPath(
                new URL(
                  `../../../.artifacts/ssh-proxy-mode/${width}-${locale}.png`,
                  import.meta.url,
                ),
              ),
              fullPage: true,
            });
            await page
              .getByRole("button", {
                name: locale === "zh" ? "开始连接" : "Start connection",
                exact: true,
              })
              .click();
            assert.equal(
              await page.evaluate(() => window.remoteConnectionFixture.attempts[0].target.useProxy),
              true,
            );
            assert.equal(
              await page.evaluate(
                () => window.remoteConnectionFixture.attempts[0].target.proxyProfileId,
              ),
              "fixture-http",
            );
            assert.equal(
              await page.evaluate(
                () => window.remoteConnectionFixture.attempts[0].target.assetInstallMode,
              ),
              "remote-download",
            );
          } finally {
            await page.close();
            assert.deepEqual(errors, []);
          }
        });
      }

    await t.test(
      "deleted selection is retained with an error and can be changed to direct",
      async () => {
        const page = await browser.newPage();
        try {
          await page.goto(`http://127.0.0.1:${port}/test/fixtures/remote-connection.html`);
          await page.getByTestId("ssh-connect-trigger").click();
          const selection = page.getByTestId("ssh-proxy-mode");
          await selection.click();
          await page.getByRole("option", { name: /Home SOCKS5/ }).click();
          await page.evaluate(() => window.remoteConnectionFixture.setProxies([]));
          await page
            .getByText("The selected proxy was deleted. Choose another proxy.", { exact: true })
            .waitFor();
          await selection.click();
          await page.getByRole("option", { name: "Direct (no proxy)", exact: true }).click();
          assert.equal(
            await page
              .getByText("No saved proxies. Add one in Settings to use it here.", { exact: true })
              .count(),
            0,
          );
          await page.getByTestId("ssh-host-input").fill("fixture.invalid");
          await page.getByTestId("ssh-username-input").fill("fixture");
          await page.getByTestId("ssh-password-input").fill("fixture-password");
          await page.getByRole("button", { name: "Start connection", exact: true }).click();
          const target = await page.evaluate(
            () => window.remoteConnectionFixture.attempts[0].target,
          );
          assert.equal(target.useProxy, undefined);
          assert.equal(target.proxyProfileId, undefined);
        } finally {
          await page.close();
        }
      },
    );

    await t.test("local proxy library read failure can be retried", async () => {
      const page = await browser.newPage();
      try {
        await page.goto(`http://127.0.0.1:${port}/test/fixtures/remote-connection.html`);
        await page.evaluate(() => window.remoteConnectionFixture.setProxyReadError(true));
        await page.getByTestId("ssh-connect-trigger").click();
        await page.getByText("Unable to load saved proxies.", { exact: true }).waitFor();
        await page.evaluate(() => window.remoteConnectionFixture.setProxyReadError(false));
        await page.getByRole("button", { name: "Retry", exact: true }).click();
        await page.getByTestId("ssh-proxy-mode").click();
        await page.getByRole("option", { name: /Home SOCKS5/ }).click();
      } finally {
        await page.close();
      }
    });

    await t.test(
      "empty alias list can be opened and searched without duplicated hints",
      async () => {
        const page = await browser.newPage();
        page.setDefaultTimeout(10_000);
        try {
          await page.goto(`http://127.0.0.1:${port}/test/fixtures/remote-connection.html`);
          await page.getByTestId("ssh-connect-trigger").click();
          const alias = page.getByTestId("ssh-config-alias-select");
          await page.getByText("No aliases", { exact: true }).waitFor();
          assert.equal(
            await page
              .getByText("No SSH config aliases available on this machine.", { exact: true })
              .count(),
            0,
          );
          await alias.click();
          const search = page.getByPlaceholder("Search SSH config alias");
          await page
            .getByText("No SSH config aliases available on this machine.", { exact: true })
            .waitFor();
          await search.fill("missing-alias");
          await page
            .getByText("No SSH config aliases available on this machine.", { exact: true })
            .waitFor();
          await search.fill("");
          await page.getByRole("option", { name: "No alias selected", exact: true }).click();
          await search.waitFor({ state: "detached" });
          assert.equal(await alias.innerText(), "No aliases");
          assert.equal(
            await page
              .getByText("No SSH config aliases available on this machine.", { exact: true })
              .count(),
            0,
          );
        } finally {
          await page.close();
        }
      },
    );

    await t.test(
      "existing aliases remain searchable and populate the connection fields",
      async () => {
        const page = await browser.newPage();
        try {
          await page.goto(
            `http://127.0.0.1:${port}/test/fixtures/remote-connection.html?aliases=available`,
          );
          await page.getByTestId("ssh-connect-trigger").click();
          await page.getByTestId("ssh-config-alias-select").click();
          await page.getByPlaceholder("Search SSH config alias").fill("fixture-alias");
          await page.getByRole("option", { name: /fixture-alias/ }).click();
          assert.equal(await page.getByTestId("ssh-host-input").inputValue(), "fixture.invalid");
          assert.equal(await page.getByTestId("ssh-port-input").inputValue(), "2222");
          assert.equal(await page.getByTestId("ssh-username-input").inputValue(), "fixture");
        } finally {
          await page.close();
        }
      },
    );

    await t.test("alias read failure remains visible", async () => {
      const page = await browser.newPage();
      try {
        await page.goto(
          `http://127.0.0.1:${port}/test/fixtures/remote-connection.html?aliases=error`,
        );
        await page.getByTestId("ssh-connect-trigger").click();
        await page
          .getByText(
            "Failed to load SSH config aliases. You can still enter connection info manually.",
            { exact: true },
          )
          .waitFor();
      } finally {
        await page.close();
      }
    });
  },
);
