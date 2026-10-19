import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "composer predictions: live transition, draft isolation, keyboard, stale responses and mobile",
  { timeout: 180_000 },
  async (t) => {
    const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
    const artifact = fileURLToPath(
      new URL("../../../.lcode/composer-prediction/", import.meta.url),
    );
    await mkdir(artifact, { recursive: true });
    const errors = [];
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(15_000);
    const load = async (query = "") => {
      await page.goto(`http://127.0.0.1:${port}/test/fixtures/composer-prediction.html?${query}`);
      await page.getByTestId("setting").filter({ hasText: "true" }).waitFor();
    };
    const editor = page.getByTestId("prediction-editor");
    const ghost = page.getByTestId("composer-prediction");
    const complete = async () => {
      await page.getByTestId("complete").click();
      await ghost.waitFor();
    };
    await t.test(
      "recovery has zero requests; completion displays without draft writes or automatic send",
      async () => {
        await load("recovery");
        assert.equal(await ghost.count(), 0);
        assert.equal(await page.evaluate(() => window.__prediction.calls), 0);
        await page.getByTestId("start").click();
        await complete();
        assert.equal((await editor.innerText()).trim(), "");
        assert.ok(
          (await page.evaluate(() => window.__prediction.drafts)).every((text) => text === ""),
        );
        await editor.focus();
        await page.keyboard.press("Enter");
        assert.deepEqual(await page.evaluate(() => window.__prediction.submits), []);
        await page.keyboard.press("Tab");
        await page.getByTestId("draft").filter({ hasText: "补充断线重连的回归验证" }).waitFor();
        assert.equal(await ghost.count(), 0);
        assert.deepEqual(await page.evaluate(() => window.__prediction.submits), []);
        assert.equal(
          await editor.evaluate((element) => element === document.activeElement),
          true,
          "Tab acceptance retains editor focus",
        );
        await page.keyboard.press("End");
        await page.keyboard.type(", mobile checks");
        await page.getByTestId("draft").filter({ hasText: "mobile checks" }).waitFor();
        await page.keyboard.press("Enter");
        assert.equal((await page.evaluate(() => window.__prediction.submits)).length, 1);
      },
    );
    await t.test(
      "desktop pointer clicks only focus and leave free input independent of the suggestion",
      async () => {
        for (const target of ["text", "blank", "hint"]) {
          await load();
          await complete();
          const area = await editor.boundingBox();
          const point =
            target === "blank"
              ? { x: area.x + area.width / 2, y: area.y + area.height - 3 }
              : await ghost
                  .locator(target === "text" ? "span" : "kbd")
                  .boundingBox()
                  .then((box) => ({ x: box.x + 4, y: box.y + 4 }));
          await page.mouse.click(point.x, point.y);
          assert.equal((await editor.innerText()).trim(), "", `${target} click must not accept`);
          assert.ok(
            (await page.evaluate(() => window.__prediction.drafts)).every((value) => value === ""),
          );
          assert.equal(
            await editor.evaluate((element) => element === document.activeElement),
            true,
          );
          assert.equal(await page.getByTestId("composer-prediction-accept").isVisible(), false);
          await page.keyboard.insertText("我自己的输入 " + target);
          await page
            .getByTestId("draft")
            .filter({ hasText: "我自己的输入 " + target })
            .waitFor();
          assert.equal(await editor.innerText(), "我自己的输入 " + target);
          assert.deepEqual(await page.evaluate(() => window.__prediction.submits), []);
          await ghost.waitFor({ state: "detached" });
        }
      },
    );
    await t.test("Escape, Shift+Tab and IME preserve normal editor behavior", async () => {
      await load();
      await complete();
      await editor.focus();
      await page.keyboard.press("Shift+Tab");
      assert.equal((await editor.innerText()).trim(), "");
      await editor.focus();
      await page.keyboard.press("Escape");
      await ghost.waitFor({ state: "detached" });
      await page.getByTestId("start").click();
      await complete();
      await editor.focus();
      const ime = await page.context().newCDPSession(page);
      await ime.send("Input.imeSetComposition", { text: "中", selectionStart: 1, selectionEnd: 1 });
      await ghost.waitFor({ state: "detached" });
      await ime.send("Input.insertText", { text: "中文" });
      await page.getByTestId("draft").filter({ hasText: "中文" }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.__prediction.submits), []);
      await ime.detach();
    });
    await t.test(
      "recovery completion after an observed running state never generates",
      async () => {
        await load();
        await page.getByTestId("recover").click();
        assert.equal(await page.evaluate(() => window.__prediction.calls), 0);
        assert.equal(await ghost.count(), 0);
        await page.getByTestId("start").click();
        await complete();
        assert.equal(await page.evaluate(() => window.__prediction.calls), 1);
      },
    );
    await t.test(
      "late results after typing, scope changes or setting changes are discarded",
      async () => {
        for (const action of ["type", "switch-session", "switch-workspace", "setting"]) {
          await load();
          await page.getByTestId("hold").click();
          await page.getByTestId("complete").click();
          await page.waitForFunction(() => window.__prediction.calls === 1);
          if (action === "type") {
            await editor.fill("my draft");
            await editor.fill("");
          } else await page.getByTestId(action).click();
          await page.getByTestId("release").click();
          await page.waitForFunction(() => window.__prediction.settled === 1);
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
          assert.equal(await ghost.count(), 0);
          assert.equal(await page.evaluate(() => window.__prediction.calls), 1);
        }
      },
    );
    await t.test(
      "pending queue suppresses the request; mobile click accepts without sending",
      async () => {
        await load();
        await page.getByTestId("queue").click();
        await page.getByTestId("complete").click();
        assert.equal(await page.evaluate(() => window.__prediction.calls), 0);
        const mobile = await browser.newPage({
          viewport: { width: 320, height: 700 },
          isMobile: true,
          hasTouch: true,
        });
        mobile.on("pageerror", (error) => errors.push(error.message));
        await mobile.goto(`http://127.0.0.1:${port}/test/fixtures/composer-prediction.html`);
        await mobile.getByTestId("setting").filter({ hasText: "true" }).waitFor();
        await mobile.getByTestId("complete").tap();
        const mobileGhost = mobile.getByTestId("composer-prediction");
        await mobileGhost.waitFor();
        assert.equal(await mobileGhost.locator("kbd").isVisible(), false);
        await mobile.screenshot({ path: `${artifact}/mobile.png` });
        const touchText = await mobileGhost.locator("span").boundingBox();
        await mobile.touchscreen.tap(touchText.x + 4, touchText.y + 4);
        assert.equal((await mobile.getByTestId("prediction-editor").innerText()).trim(), "");
        assert.equal(
          await mobile
            .getByTestId("prediction-editor")
            .evaluate((element) => element === document.activeElement),
          true,
        );
        await mobile.keyboard.insertText("触屏自由输入");
        await mobile.getByTestId("draft").filter({ hasText: "触屏自由输入" }).waitFor();
        assert.equal(await mobile.getByTestId("prediction-editor").innerText(), "触屏自由输入");
        await mobileGhost.waitFor({ state: "detached" });
        await mobile.reload();
        await mobile.getByTestId("setting").filter({ hasText: "true" }).waitFor();
        await mobile.getByTestId("complete").tap();
        await mobileGhost.waitFor();
        await mobile.getByTestId("composer-prediction-accept").tap();
        await mobile.getByTestId("draft").filter({ hasText: "补充断线重连的回归验证" }).waitFor();
        assert.deepEqual(await mobile.evaluate(() => window.__prediction.submits), []);
        assert.equal(
          await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        await mobile.close();
      },
    );
    assert.deepEqual(errors, [], diagnostics());
    await page.close();
  },
);
