import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "Composer 旗舰与最高思考特效：真实改选、主题、手机、减少动态效果和冻结提交",
  { timeout: 180_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const artifacts = fileURLToPath(
      new URL("../../../.lcode/composer-model-emphasis/", import.meta.url),
    );
    await mkdir(artifacts, { recursive: true });
    for (const width of [1280, 390, 320]) {
      await t.test(`${width}px 改选与提交`, async () => {
        const context = await browser.newContext({
          viewport: { width, height: 800 },
          isMobile: width < 1280,
          hasTouch: width < 1280,
        });
        const page = await context.newPage();
        page.setDefaultTimeout(10_000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          const query = new URLSearchParams({
            modelEmphasis: "",
            initialThought: "low",
            thoughtLevels: "disabled,low,high,ultra",
          });
          if (width === 390) query.set("existing", "");
          if (width === 320) query.set("english", "");
          await page.goto(
            `http://127.0.0.1:${port}/test/fixtures/conversation-send.html?${query}`,
            { timeout: 60_000 },
          );
          const shell = page.locator(".chat-prompt-shell");
          await shell.waitFor();
          assert.equal(await shell.getAttribute("data-composer-presentation"), "prompt-bar");
          const surface = () =>
            shell.evaluate((element) => {
              const style = getComputedStyle(element);
              return {
                background: style.backgroundColor,
                border: style.borderTopColor,
                gap: style.rowGap,
                padding: style.paddingTop,
              };
            });
          const normalSurface = await surface();
          assert.equal(normalSurface.gap, "8px");
          assert.equal(normalSurface.padding, "12px");
          assert.equal(normalSurface.border, "rgba(0, 0, 0, 0)");
          const editorMetrics = await page.getByTestId("v4-composer-input").evaluate((element) => ({
            min: getComputedStyle(element).minHeight,
            line: getComputedStyle(element).lineHeight,
          }));
          assert.equal(editorMetrics.min, editorMetrics.line);
          assert.equal(
            await shell.evaluate((element) => {
              const placeholder = element.querySelector("[data-prompt-editor-placeholder]");
              const toolbar = element.querySelector("[data-composer-toolbar]");
              return (
                !placeholder ||
                placeholder.getBoundingClientRect().bottom <= toolbar.getBoundingClientRect().top
              );
            }),
            true,
          );
          assert.equal(await shell.getAttribute("data-composer-model-emphasis"), "false");
          const bounds = await shell.boundingBox();
          await page.getByTestId("chat-thought-level-select-trigger").click();
          const slider = page.getByRole("slider");
          await slider.press("End");
          await page.waitForFunction(
            () =>
              document.querySelector(".chat-prompt-shell")?.dataset.composerModelEmphasis ===
              "true",
          );
          assert.deepEqual(await shell.boundingBox(), bounds);
          assert.deepEqual(await surface(), normalSurface);
          const thoughtTrigger = page.getByTestId("chat-thought-level-select-trigger");
          assert.equal(await thoughtTrigger.getAttribute("data-thought-peak"), "true");
          assert.equal(await thoughtTrigger.locator(".lucide-sparkles").count(), 1);
          // 标记先提交，原生颜色过渡随后呈现；等待实际过渡完成再比较最终强调色。
          await thoughtTrigger.evaluate((element) => {
            element.getBoundingClientRect();
            return Promise.all(element.getAnimations().map((animation) => animation.finished));
          });
          assert.notEqual(
            await thoughtTrigger.evaluate((element) => getComputedStyle(element).color),
            await page
              .getByTestId("chat-model-select-trigger")
              .evaluate((element) => getComputedStyle(element).color),
          );
          const sparks = shell.locator(".composer-model-sparks");
          assert.equal(await sparks.getAttribute("aria-hidden"), "true");
          assert.equal(await sparks.locator(".composer-model-spark").count(), 24);
          assert.equal(
            await shell
              .locator(".composer-model-sparks")
              .evaluate((el) => getComputedStyle(el).pointerEvents),
            "none",
          );
          await slider.press("ArrowLeft");
          await page.waitForFunction(
            () =>
              document.querySelector(".chat-prompt-shell")?.dataset.composerModelEmphasis ===
              "false",
          );
          await page.keyboard.press("Escape");
          await page.getByTestId("chat-thought-level-slider-panel").waitFor({ state: "detached" });
          const choose = async (name) => {
            await page.getByTestId("chat-model-select-trigger").click();
            const group = page.locator("[data-model-provider-key]");
            if ((await group.count()) && (await group.getAttribute("role")) === "menuitem") {
              await group.click();
              await group.press("ArrowRight");
            }
            await page.getByRole("menuitemradio", { name, exact: false }).click();
            await page
              .locator('[data-slot="dropdown-menu-content"]')
              .waitFor({ state: "detached" });
          };
          await choose("gpt-6.1-sol");
          await page.waitForFunction(
            () =>
              document.querySelector(".chat-prompt-shell")?.dataset.composerModelEmphasis ===
              "true",
          );
          // 同一旗舰从关到最高档必须改变实际画面，不能只断言特效仍然开启。
          await thoughtTrigger.click();
          const levels = [];
          for (const key of ["Home", "ArrowRight", "ArrowRight", "End"]) {
            await slider.press(key);
            await shell.evaluate((element) => {
              element.getBoundingClientRect();
              return Promise.all(element.getAnimations().map((animation) => animation.finished));
            });
            levels.push(
              await sparks.evaluate((element) => {
                const particle = element.querySelector(".composer-model-spark");
                return {
                  glow: Number(getComputedStyle(element.parentElement, "::before").opacity),
                  scale: Number(getComputedStyle(particle).scale),
                  rate: particle.getAnimations()[0].playbackRate,
                  visible: [...element.children].filter(
                    (child) => getComputedStyle(child).display !== "none",
                  ).length,
                };
              }),
            );
          }
          for (let index = 1; index < levels.length; index++) {
            assert.ok(levels[index].glow > levels[index - 1].glow, "升档底光应增强");
            assert.ok(levels[index].rate > levels[index - 1].rate, "升档粒子应加速");
            assert.ok(levels[index].scale > levels[index - 1].scale, "升档粒子应增大");
            assert.ok(levels[index].visible >= levels[index - 1].visible);
          }
          await slider.press("ArrowLeft");
          await page.keyboard.press("Escape");
          await page.getByTestId("chat-thought-level-slider-panel").waitFor({ state: "detached" });
          await choose("gpt-6-luna");
          await page.waitForFunction(
            () =>
              document.querySelector(".chat-prompt-shell")?.dataset.composerModelEmphasis ===
              "false",
          );
          await choose("gpt-6.1-sol");
          await page.waitForFunction(
            () =>
              document.querySelector(".chat-prompt-shell")?.dataset.composerModelEmphasis ===
              "true",
          );
          if (width === 320)
            await page.evaluate(() =>
              document.documentElement.style.setProperty("--ui-font-size", "20px"),
            );
          for (const theme of [
            "zai-dark",
            "zai-light",
            "sepia-light",
            "midnight-blue",
            "forest-dark",
            "cinnabar",
            "inkpurple",
          ]) {
            await page.evaluate((id) => {
              document.documentElement.className = `${["zai-dark", "inkpurple"].includes(id) ? "dark " : ""}theme-${id}`;
            }, theme);
            assert.equal(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
              true,
            );
            const box = await shell.boundingBox();
            assert.ok(box.x >= 0 && box.x + box.width <= width);
            if (["zai-dark", "zai-light", "inkpurple"].includes(theme))
              await shell.evaluate((element) =>
                Promise.all(
                  element
                    .getAnimations({ subtree: true })
                    .filter(
                      (animation) => animation.effect.getComputedTiming().iterations !== Infinity,
                    )
                    .map((animation) => animation.finished),
                ),
              );
            if (["zai-dark", "zai-light", "inkpurple"].includes(theme))
              await shell.screenshot({
                path: `${artifacts}/${width}-${theme}.png`,
                animations: "allow",
              });
          }
          const particleFrame = () =>
            sparks.locator(".composer-model-spark").evaluateAll((elements) =>
              elements.map((element) => {
                const style = getComputedStyle(element);
                return {
                  transform: style.transform,
                  opacity: style.opacity,
                  display: style.display,
                };
              }),
            );
          const firstFrame = await particleFrame();
          assert.equal(
            firstFrame.filter((entry) => entry.display !== "none").length,
            width === 1280 ? 20 : 16,
          );
          assert.ok(new Set(firstFrame.map((entry) => entry.transform)).size > 8);
          assert.equal(
            await sparks.evaluate((element) => getComputedStyle(element).overflow),
            "hidden",
          );
          const animationTime = await shell.evaluate(
            (el) =>
              el
                .getAnimations({ subtree: true })
                .find((animation) => animation.animationName === "composer-spark-rise")
                ?.currentTime,
          );
          assert.equal(typeof animationTime, "number");
          await page.waitForFunction(
            (previous) =>
              document
                .querySelector(".chat-prompt-shell")
                ?.getAnimations({ subtree: true })
                .some(
                  (animation) =>
                    animation.animationName === "composer-spark-rise" &&
                    animation.currentTime > previous + 80,
                ),
            animationTime,
          );
          const secondFrame = await particleFrame();
          assert.notDeepEqual(
            secondFrame.map((entry) => entry.transform),
            firstFrame.map((entry) => entry.transform),
          );
          assert.notDeepEqual(
            secondFrame.map((entry) => entry.opacity),
            firstFrame.map((entry) => entry.opacity),
          );
          const editor = page.getByTestId("v4-composer-input");
          const themedSurface = await surface();
          const send = page.getByTestId("v4-composer-send");
          const idleSend = await send.evaluate(
            (element) => getComputedStyle(element).backgroundColor,
          );
          const sparkPresentation = () =>
            sparks.evaluate((element) => {
              const particle = element.querySelector(".composer-model-spark");
              return {
                filter: getComputedStyle(element).filter,
                scale: Number(getComputedStyle(particle).scale),
                rate: particle.getAnimations()[0]?.playbackRate,
                boost: Number(getComputedStyle(element).getPropertyValue("--composer-spark-boost")),
              };
            });
          const idleSparks = await sparkPresentation();
          await editor.pressSequentially("S");
          const typingSparks = await sparkPresentation();
          assert.ok(typingSparks.rate > idleSparks.rate * 2, "首字符应明显加速");
          assert.ok(typingSparks.scale > idleSparks.scale * 1.4, "首字符应明显放大");
          assert.notEqual(typingSparks.filter, idleSparks.filter);
          assert.deepEqual(await surface(), themedSurface);
          assert.notEqual(
            await send.evaluate((element) => getComputedStyle(element).backgroundColor),
            idleSend,
          );
          await editor.pressSequentially("park");
          assert.equal(await sparks.locator(".composer-model-spark").count(), 24);
          await editor.pressSequentially(" typing");
          assert.ok((await sparkPresentation()).boost > 0.8);
          await page.waitForFunction(
            () =>
              Number(
                getComputedStyle(document.querySelector(".composer-model-sparks")).getPropertyValue(
                  "--composer-spark-boost",
                ),
              ) === 0,
          );
          assert.deepEqual(await sparkPresentation(), idleSparks);
          await editor.evaluate((element) => {
            const clipboardData = new DataTransfer();
            clipboardData.setData("text/plain", " paste");
            element.dispatchEvent(
              new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
            );
          });
          assert.ok((await sparkPresentation()).boost > 0.8, "Lexical 接管粘贴也应触发反馈");
          await page.keyboard.insertText("中文输入");
          assert.ok((await sparkPresentation()).boost > 0.8);
          await editor.press("Backspace");
          assert.ok((await sparkPresentation()).boost > 0.8);
          // 媒体协议返回早于浏览器派发 change；等同一原生事件，不能把未派发误判为未取消动画。
          await page.evaluate(() => {
            globalThis.__sparkReducedObserved = false;
            const media = matchMedia("(prefers-reduced-motion: reduce)");
            media.addEventListener(
              "change",
              () => {
                globalThis.__sparkReducedObserved = media.matches;
              },
              { once: true },
            );
          });
          await page.emulateMedia({ reducedMotion: "reduce" });
          await page.waitForFunction(() => globalThis.__sparkReducedObserved);
          assert.equal(
            await shell.evaluate(
              (el) =>
                el
                  .getAnimations({ subtree: true })
                  .filter((animation) => animation.animationName === "composer-spark-rise").length,
            ),
            0,
          );
          assert.notEqual(
            await shell.evaluate((el) => getComputedStyle(el, "::before").backgroundImage),
            "none",
          );
          assert.equal(
            await sparks
              .locator(".composer-model-spark")
              .first()
              .evaluate((element) => getComputedStyle(element).display),
            "none",
          );
          await editor.pressSequentially(" reduced");
          assert.equal(await sparks.evaluate((element) => element.getAnimations().length), 0);
          assert.equal((await sparkPresentation()).boost, 0);
          await page.emulateMedia({ reducedMotion: "no-preference" });
          await page.waitForFunction(
            () => document.querySelector(".composer-model-spark")?.getAnimations().length > 0,
          );
          await editor.press("R");
          assert.ok((await sparkPresentation()).boost > 0.8, "恢复动态效果后可再次激发");
          await page.emulateMedia({ forcedColors: "active" });
          assert.equal(
            await shell
              .locator(".composer-model-sparks")
              .evaluate((el) => getComputedStyle(el).display),
            "none",
          );
          await page.emulateMedia({ forcedColors: "none" });
          assert.equal(await page.evaluate(() => globalThis.__sendFixture.calls.length), 0);
          await page.getByTestId("v4-composer-input").fill("model emphasis regression");
          await page.waitForFunction(
            () => !document.querySelector('[data-testid="v4-composer-send"]')?.disabled,
          );
          await page.evaluate(() => {
            globalThis.__sendFixture.hold = true;
          });
          await page.getByTestId("v4-composer-send").click();
          await page.waitForFunction(() => globalThis.__sendFixture.calls.length === 1);
          await page.waitForFunction(
            () =>
              document.querySelector(".chat-prompt-shell")?.dataset.composerModelEmphasis ===
              "false",
          );
          const [call] = await page.evaluate(() => globalThis.__sendFixture.calls);
          assert.equal(call.options.submission.modelSelection.modelId, "gpt-6.1-sol");
          assert.deepEqual(call.options.submission.modelSelection.options, {
            reasoningLevel: "high",
            speed: "fast",
          });
          await page.evaluate(() => globalThis.__sendFixture.release());
          await page.waitForFunction(
            () =>
              document.querySelector(".chat-prompt-shell")?.dataset.composerModelEmphasis ===
              "true",
          );
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });
    }
  },
);
