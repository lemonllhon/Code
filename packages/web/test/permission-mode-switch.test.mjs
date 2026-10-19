import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "permission modes use the real draft owner and gate submissions until the current Host accepts",
  { timeout: 180_000 },
  async (t) => {
    const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
    for (const width of [1280, 390])
      await t.test(`${width}px`, async () => {
        const page = await browser.newPage({
          viewport: { width, height: 800 },
          reducedMotion: "reduce",
        });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.setDefaultTimeout(20_000);
        // 首次导航包含 Vite 冷编译；与真实交互等待分开，不用延时等待业务状态。
        page.setDefaultNavigationTimeout(60_000);
        const load = async (existing = false) => {
          await page.goto(
            `http://127.0.0.1:${port}/test/fixtures/conversation-send.html?permissionSwitch${existing ? "&existing" : ""}`,
          );
          await page.getByTestId("chat-mode-select-trigger").waitFor();
        };
        const select = async (mode) => {
          await page.getByTestId("chat-mode-select-trigger").click();
          await page.getByTestId(`chat-mode-select-item-${mode}`).click();
        };
        const draft = () => page.getByTestId("permission-draft");
        const state = () => draft().textContent().then(JSON.parse);
        const waitState = (expected) =>
          page
            .waitForFunction((values) => {
              const current = JSON.parse(
                document.querySelector('[data-testid="permission-draft"]').textContent,
              );
              return Object.entries(values).every(([key, value]) => current[key] === value);
            }, expected)
            .catch(async (error) => {
              throw new Error(
                `${error.message}; expected=${JSON.stringify(expected)}; actual=${await draft().textContent()}; errors=${errors.join("; ")}`,
              );
            });
        const typeSend = async (text) => {
          const editor = page.getByTestId("v4-composer-input");
          await editor.fill(text);
          await editor.press("Enter");
        };
        await load();
        await select("yolo");
        await waitState({ mode: "yolo", pending: false });
        assert.equal(
          await page.evaluate(() => __permissions.requests.length),
          0,
          "new task selection remains a draft",
        );
        await typeSend("first input");
        await page.waitForFunction(() => __permissions.sends.length === 1);
        assert.equal(await page.evaluate(() => __permissions.sends[0].mode), "yolo");
        await waitState({ sessionId: "created", mode: "yolo" });

        await select("plan");
        await waitState({ plan: true });
        await page.evaluate(() => {
          __permissions.hold = true;
        });
        await select("edit");
        await waitState({ pending: true, mode: "yolo" });
        assert.equal(await page.getByTestId("chat-mode-select-trigger").isDisabled(), true);
        await typeSend("held input");
        assert.equal(
          await page.evaluate(() => __permissions.sends.length),
          1,
          "Enter cannot freeze the previous permission while ACK is pending",
        );
        await page.evaluate(() => {
          __permissions.hold = false;
          __permissions.release();
        });
        await waitState({ mode: "edit", pending: false, plan: true });
        assert.deepEqual(await page.evaluate(() => __permissions.requests), [
          { sessionId: "created", mode: "edit" },
        ]);
        await page.getByTestId("v4-composer-input").press("Enter");
        await page.waitForFunction(() => __permissions.sends.length === 2);
        assert.deepEqual(
          await page.evaluate(() => ({
            mode: __permissions.sends[1].mode,
            planEnabled: __permissions.sends[1].planEnabled,
          })),
          { mode: "edit", planEnabled: true },
        );

        await page.evaluate(() => {
          __permissions.fail = true;
        });
        await select("build");
        await page.waitForFunction(() => __permissions.errors.length === 1);
        await waitState({ mode: "edit", pending: false });
        await page.evaluate(() => {
          __permissions.fail = false;
          __permissions.hold = true;
        });
        await select("yolo");
        await waitState({ pending: true });
        await page.evaluate(() => __permissions.changeScope());
        await waitState({ sessionId: "other", mode: "build", pending: false });
        await page.evaluate(() => {
          __permissions.hold = false;
          __permissions.release();
        });
        await page.waitForFunction(() => __permissions.requests.length === 3);
        assert.equal(
          (await state()).mode,
          "build",
          "old scope completion must not update the new draft",
        );
        await page.evaluate(() => __permissions.grant("yolo", "dialog-grant"));
        await waitState({ mode: "yolo" });
        await select("edit");
        await waitState({ mode: "edit", pending: false });
        await page.evaluate(() => __permissions.grant("yolo", "dialog-grant"));
        assert.equal(
          (await state()).mode,
          "edit",
          "replayed receipt must not overwrite a later explicit selection",
        );
        await page.evaluate(() => {
          __permissions.hold = true;
        });
        await select("build");
        await waitState({ pending: true });
        await page.evaluate(() => __permissions.changeOwner());
        await waitState({ pending: false });
        await page.evaluate(() => {
          __permissions.hold = false;
          __permissions.release();
        });
        assert.equal(
          (await state()).mode,
          "edit",
          "old Host completion must not update the new owner",
        );
        await page.evaluate(() => {
          __permissions.holdSend = true;
        });
        await typeSend("attachment preparation");
        await page.waitForFunction(() => __permissions.prepared === 3);
        await select("yolo");
        await waitState({ mode: "yolo", pending: false });
        await page.evaluate(() => {
          __permissions.holdSend = false;
          __permissions.releaseSend();
        });
        await page.waitForFunction(() =>
          document
            .querySelector('[data-testid="v4-composer-input"]')
            .textContent.includes("attachment preparation"),
        );
        assert.equal(
          await page.evaluate(() => __permissions.sends.length),
          2,
          "a late send cannot restore the permission frozen before preparation",
        );
        await page.evaluate(() => __permissions.seedLegacyDraft());
        await load(true);
        await waitState({ mode: "build", sessionId: "existing" });
        await page.evaluate(() => {
          __permissions.project = false;
        });
        await select("yolo");
        await waitState({ mode: "yolo", pending: false });
        await page.evaluate(() => {
          __permissions.externalMode("edit");
          __permissions.externalMode("build");
        });
        await waitState({ mode: "build" });
        assert.deepEqual(errors, [], diagnostics());
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          "mobile has no horizontal overflow",
        );
        await page.close();
      });
  },
);
