import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "队列用量停靠：三种原位置、清空恢复、草稿稳定、开关和手机",
  { timeout: 180_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const artifacts = fileURLToPath(new URL("../../../.lcode/queue-statusbar/", import.meta.url));
    await mkdir(artifacts, { recursive: true });
    for (const width of [1280, 390, 320]) {
      await t.test(`${width}px 队列上方与原位置恢复`, async () => {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          isMobile: width < 1280,
          hasTouch: width < 1280,
        });
        const page = await context.newPage();
        page.setDefaultTimeout(10_000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          await page.goto(`http://127.0.0.1:${port}/test/fixtures/token-usage-statusbar.html`, {
            timeout: 60_000,
          });
          const dock = page.getByTestId("production-composer");
          const bar = dock.getByTestId("token-usage-statusbar");
          const queue = dock.getByTestId("v4-queue");
          const editor = dock.getByTestId("v4-composer-input");
          await bar.waitFor();
          await editor.evaluate((element) => {
            globalThis.__queueOriginalEditor = element;
          });
          const settings = () =>
            page.evaluate(() => localStorage.getItem("fixture-token-settings"));
          const setQueue = (count, guide = false, paused = false) =>
            page.evaluate(
              ([count, guide, paused]) => globalThis.__tokenFixture.queue(count, guide, paused),
              [count, guide, paused],
            );
          const conversation = () =>
            page.getByRole("button", { name: "Conversation view", exact: true }).click();
          const openSettings = async () => {
            await page.keyboard.press("Escape");
            await page.mouse.move(5, 5);
            await page
              .locator('[data-testid^="token-usage-detail-"]:visible')
              .waitFor({ state: "hidden" });
            await page.getByRole("button", { name: "Settings view", exact: true }).click();
          };
          const choosePosition = async (position) => {
            await openSettings();
            await page.getByTestId("token-usage-statusbar-position").click();
            await page
              .getByRole("option", {
                name: { inside: "输入框内部底部", above: "输入框上方", below: "输入框下方" }[
                  position
                ],
                exact: true,
              })
              .click();
            await page.waitForFunction((name) => {
              const control = document.querySelector(
                '[data-testid="token-usage-statusbar-position"]',
              );
              return control?.textContent.includes(name) && !control.disabled;
            }, { inside: "输入框内部底部", above: "输入框上方", below: "输入框下方" }[position]);
            await conversation();
          };
          const restored = async (position) => {
            await queue.waitFor({ state: "detached" });
            await dock
              .locator(
                `[data-composer-statusbar-slot="${position}"] [data-testid="token-usage-statusbar"]`,
              )
              .waitFor();
            assert.equal(await bar.count(), 1);
            assert.equal(await bar.getAttribute("data-placement"), position);
            assert.equal(
              await editor.evaluate((element) => element === globalThis.__queueOriginalEditor),
              true,
            );
          };
          const aboveQueue = async () => {
            await dock
              .locator(
                '[data-composer-statusbar-slot="queue-above"] [data-testid="token-usage-statusbar"]',
              )
              .waitFor();
            assert.equal(await bar.count(), 1);
            assert.equal(await bar.getAttribute("data-placement"), "above");
            const geometry = await dock.evaluate((element) => {
              const bar = element
                .querySelector('[data-testid="token-usage-statusbar"]')
                .getBoundingClientRect();
              const queue = element
                .querySelector('[data-testid="v4-queue"]')
                .getBoundingClientRect();
              const editor = element
                .querySelector('[data-testid="v4-composer-input"]')
                .getBoundingClientRect();
              const shell = element.querySelector(".chat-prompt-shell").getBoundingClientRect();
              return {
                barBottom: bar.bottom,
                queueTop: queue.top,
                queueBottom: queue.bottom,
                editorTop: editor.top,
                shellTop: shell.top,
                width: element.scrollWidth,
                viewport: innerWidth,
              };
            });
            assert.ok(geometry.barBottom <= geometry.queueTop, JSON.stringify(geometry));
            assert.ok(geometry.queueTop < geometry.editorTop, JSON.stringify(geometry));
            assert.ok(
              geometry.shellTop <= geometry.queueBottom,
              "队列与输入框之间不应留下状态栏或标题占位",
            );
            assert.ok(geometry.width <= geometry.viewport, JSON.stringify(geometry));
          };
          for (const position of ["inside", "above", "below"]) {
            await choosePosition(position);
            const before = await settings();
            await editor.fill("保留的草稿");
            await setQueue(1);
            await aboveQueue();
            await setQueue(2, false, true);
            await aboveQueue();
            assert.equal(await queue.getAttribute("data-queue-count"), "2");
            assert.equal(await queue.getAttribute("data-queue-auto-drain"), "false");
            await queue
              .getByRole("button", { name: "移除待发送消息", exact: true })
              .first()
              .click();
            assert.equal(await queue.getAttribute("data-queue-count"), "1");
            await aboveQueue();
            await queue.getByRole("button", { name: "移除待发送消息", exact: true }).click();
            await restored(position);
            assert.equal(await editor.innerText(), "保留的草稿");
            assert.equal(await settings(), before, "临时位置不得写入用户设置");
            await setQueue(1, true);
            await restored(position);
            await setQueue(0);
          }
          await setQueue(1);
          await aboveQueue();
          await choosePosition("above");
          await aboveQueue();
          await choosePosition("below");
          await aboveQueue();
          await queue.getByRole("button", { name: "立即", exact: true }).click();
          await restored("below");
          await editor.press("ControlOrMeta+A");
          await editor.press("Backspace");
          await page.waitForFunction(
            () => document.querySelector('[data-testid="v4-composer-input"]').textContent === "",
          );
          await setQueue(1);
          await aboveQueue();
          await queue.getByRole("button", { name: "编辑", exact: true }).click();
          await restored("below");
          assert.equal(await editor.innerText(), "继续处理 1");
          await setQueue(1);
          await aboveQueue();
          for (const theme of [
            "zai-dark",
            "zai-light",
            "sepia-light",
            "midnight-blue",
            "forest-dark",
            "cinnabar",
            "inkpurple",
          ]) {
            await page.evaluate((theme) => globalThis.__tokenFixture.theme(theme), theme);
            await aboveQueue();
            if (["zai-dark", "zai-light"].includes(theme))
              await dock.screenshot({ path: `${artifacts}/${width}-${theme}.png` });
          }
          await bar.getByTestId("token-usage-session").click();
          await page.getByTestId("token-usage-detail-session").waitFor();
          await page.keyboard.press("Escape");
          await openSettings();
          await page.getByTestId("token-usage-statusbar-toggle-enabled").click();
          await conversation();
          await bar.waitFor({ state: "detached" });
          assert.equal(
            await dock.locator('[data-composer-statusbar-slot="queue-above"]').isVisible(),
            false,
          );
          await setQueue(0);
          assert.equal(
            await editor.evaluate((element) => element === globalThis.__queueOriginalEditor),
            true,
          );
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });
    }
  },
);
