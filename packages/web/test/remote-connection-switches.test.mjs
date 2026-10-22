import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { THEME_OPTIONS } from "@lcode/ui/theme-config";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "SSH choice switches remain visible and operable across themes and viewports",
  { timeout: 180_000 },
  async (t) => {
    const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, [], diagnostics()));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mkdir(".tmp/remote-connection-switches", { recursive: true });
    for (const lang of ["en", "zh"]) {
      await page.goto(`http://127.0.0.1:${port}/test/fixtures/remote-connection.html?lang=${lang}`);
      await page.getByTestId("ssh-connect-trigger").click();
      await page.getByTestId("remote-kind-ssh").click();
      assert.equal(await page.getByTestId("ssh-proxy-mode").isVisible(), true);
      const auth = page.getByRole("group", {
        name: lang === "en" ? "Authentication method" : "认证方式",
        exact: true,
      });
      const resources = page.getByRole("group", {
        name: lang === "en" ? "Resource download method" : "资源下载方式",
        exact: true,
      });
      await auth.waitFor();
      assert.deepEqual(
        await resources.getByRole("button").allTextContents(),
        lang === "en" ? ["Local upload", "Remote download"] : ["本地上传", "远端下载"],
      );
      for (const choice of await resources.getByRole("button").all()) {
        assert.ok(
          await choice.getAttribute("title"),
          "download choices keep their full explanation",
        );
      }
      for (const theme of THEME_OPTIONS.filter((option) => option.base !== "dynamic")) {
        await page.emulateMedia({
          colorScheme: theme.base === "dark" ? "light" : "dark",
          reducedMotion: "reduce",
        });
        await page.evaluate((option) => {
          document.documentElement.className = `${option.base === "dark" ? "dark " : ""}theme-${option.id}`;
        }, theme);
        for (const [width, font] of [
          [1280, 14],
          [390, 20],
          [320, 20],
        ]) {
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate(
            (size) => document.documentElement.style.setProperty("--ui-font-size", `${size}px`),
            font,
          );
          const host = await page.getByTestId("ssh-host-input").boundingBox();
          const portInput = await page.getByTestId("ssh-port-input").boundingBox();
          assert.ok(host && portInput);
          assert.ok(Math.abs(host.y - portInput.y) <= 1, "host and port align at every viewport");
          assert.ok(portInput.width <= 88, "port width stays compact at larger font sizes");
          for (const group of [auth, resources]) {
            const choices = group.getByRole("button");
            for (const [index, choice] of (await choices.all()).entries()) {
              if (index === 0) await choice.click();
              else {
                await choice.focus();
                await page.keyboard.press("Space");
              }
              assert.equal(await choice.getAttribute("aria-pressed"), "true");
              assert.equal(await group.locator('[aria-pressed="true"]').count(), 1);
              await page.mouse.move(1, 1);
              await choice.evaluate(async (element) => {
                await Promise.all(
                  element.getAnimations().map((animation) => animation.finished.catch(() => {})),
                );
              });
              const check = await choice.evaluate((element) => {
                const style = getComputedStyle(element);
                const container = getComputedStyle(element.parentElement);
                const canvas = document.createElement("canvas");
                const ctx = canvas.getContext("2d");
                const luminance = (color) => {
                  ctx.fillStyle = color;
                  ctx.fillRect(0, 0, 1, 1);
                  return Array.from(ctx.getImageData(0, 0, 1, 1).data)
                    .slice(0, 3)
                    .map((v) => v / 255)
                    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
                    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
                };
                const contrast = (a, b) =>
                  (Math.max(luminance(a), luminance(b)) + 0.05) /
                  (Math.min(luminance(a), luminance(b)) + 0.05);
                return {
                  background: style.backgroundColor,
                  parent: container.backgroundColor,
                  border: parseFloat(style.borderTopWidth),
                  edge: contrast(style.borderTopColor, container.backgroundColor),
                  text: contrast(style.color, style.backgroundColor),
                  fits:
                    element.scrollWidth <= element.clientWidth &&
                    element.scrollHeight <= element.clientHeight,
                };
              });
              const context = `${theme.id}/${lang}/${width}`;
              assert.notEqual(check.background, check.parent, `${context}: selection fill`);
              assert.ok(
                check.border >= 1 && check.edge >= 3,
                `${context}: selected edge ${check.edge}`,
              );
              assert.ok(check.text >= 4.5, `${context}: selected text ${check.text}`);
              assert.ok(check.fits, `${context}: choice text must fit`);
              await choice.hover();
              assert.equal(
                await choice.evaluate((element) => getComputedStyle(element).backgroundColor),
                check.background,
                `${context}: hover keeps selection`,
              );
              await choice.focus();
              await page.keyboard.press("Space");
              assert.equal(await choice.getAttribute("aria-pressed"), "true");
              const focus = await choice.evaluate((element) => ({
                visible: element.matches(":focus-visible"),
                ring: getComputedStyle(element).getPropertyValue("--tw-ring-shadow"),
                background: getComputedStyle(element).backgroundColor,
              }));
              assert.ok(
                focus.visible && focus.ring && focus.ring.trim() !== "0 0 #0000",
                `${context}: visible keyboard focus`,
              );
              assert.equal(focus.background, check.background, `${context}: focus keeps selection`);
            }
          }
          assert.ok(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            `${theme.id}/${lang}/${width}: no horizontal overflow`,
          );
          if (width !== 320 && lang === "zh")
            await page
              .getByTestId("ssh-dialog")
              .screenshot({ path: `.tmp/remote-connection-switches/${theme.id}-${width}.png` });
        }
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.evaluate(() =>
        document.documentElement.style.setProperty("--ui-font-size", "14px"),
      );
      await auth.getByRole("button").first().click();
      await page.getByTestId("ssh-host-input").fill("fixture.invalid");
      await page.getByTestId("ssh-username-input").fill("tester");
      await page.getByTestId("ssh-password-input").fill("fixture-password");
      await page
        .getByRole("button", { name: lang === "en" ? "Start connection" : "开始连接", exact: true })
        .click();
      assert.equal(
        await page.evaluate(
          () => window.remoteConnectionFixture.attempts.at(-1)?.target.assetInstallMode,
        ),
        "remote-download",
      );
    }
  },
);
