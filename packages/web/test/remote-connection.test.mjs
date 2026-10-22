import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "device connection saves without a directory and retries saving on the same attachment",
  { timeout: 60000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/remote-connection.html?device&auto`);
    await page.waitForFunction(() => window.remoteConnectionFixture.attempts.length === 1);
    await page.evaluate(() => {
      window.remoteConnectionFixture.failNextSave();
      window.remoteConnectionFixture.succeed(0);
    });
    await page.getByText("fixture device save failed", { exact: true }).waitFor();
    assert.equal(await page.getByTestId("ssh-success").count(), 0);
    await page.getByRole("button", { name: "Retry connection", exact: true }).click();
    await page.waitForFunction(() => window.remoteConnectionFixture.savedDevices.length === 1);
    await page.getByTestId("ssh-dialog").waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => window.remoteConnectionFixture.attempts.length), 1);
    assert.deepEqual(await page.evaluate(() => window.remoteConnectionFixture.disposed), []);
    await page.getByTestId("ssh-connect-trigger").click();
    assert.equal(await page.getByTestId("ssh-host-input").isVisible(), true);
  },
);

test(
  "new connection opens the form directly and switches types without a stepper",
  { timeout: 60000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/remote-connection.html`);
    await page.getByTestId("ssh-connect-trigger").click();
    assert.equal(await page.getByTestId("ssh-host-input").count(), 1);
    assert.equal(await page.getByRole("button", { name: "Next", exact: true }).count(), 0);
    await page.getByTestId("ssh-host-input").fill("draft.invalid");
    await page.getByTestId("remote-kind-docker").click();
    await page.getByPlaceholder(/container name or ID/i).fill("fixture-container");
    await page.getByTestId("remote-kind-ssh").click();
    assert.equal(await page.getByTestId("ssh-host-input").inputValue(), "draft.invalid");
    assert.equal(await page.getByTestId("remote-kind-ssh").getAttribute("aria-selected"), "true");
    assert.equal(await page.getByTestId("ssh-proxy-mode").isVisible(), true);
    const resources = page.getByRole("group", { name: "Resource download method", exact: true });
    assert.equal(await resources.isVisible(), true);
    assert.equal(await resources.getByRole("button").count(), 2);
    await resources.getByRole("button").nth(1).click();
    await page.getByTestId("remote-kind-docker").click();
    await page.getByTestId("remote-kind-ssh").click();
    assert.equal(await resources.getByRole("button").nth(1).getAttribute("aria-pressed"), "true");
    await page.getByTestId("remote-kind-ssh").focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="remote-kind-wsl"]').getAttribute("aria-selected") ===
        "true",
    );
    assert.equal(await page.getByTestId("remote-kind-wsl").getAttribute("aria-selected"), "true");
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/remote-connection.html?unix`);
    await page.getByTestId("ssh-connect-trigger").click();
    assert.equal(await page.getByTestId("remote-kind-wsl").count(), 0);
    assert.equal(await page.getByRole("tab").count(), 2);
    assert.equal(await resources.getByRole("button").first().getAttribute("aria-pressed"), "true");
    await page.getByTestId("ssh-host-input").fill("fixture.invalid");
    await page.getByTestId("ssh-username-input").fill("tester");
    await page.getByTestId("ssh-password-input").fill("fixture-password");
    await page.getByRole("button", { name: "Start connection", exact: true }).click();
    assert.equal(
      await page.evaluate(() => window.remoteConnectionFixture.attempts[0].target.assetInstallMode),
      "local-download-upload",
    );
  },
);

test(
  "device configure prefills saved options and open-folder creates one cancellable request",
  { timeout: 60000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/remote-connection.html?prefill`);
    await page.getByTestId("ssh-connect-trigger").click();
    assert.equal(await page.getByTestId("ssh-host-input").inputValue(), "saved.invalid");
    assert.equal(await page.getByTestId("ssh-port-input").inputValue(), "2222");
    assert.equal(await page.getByTestId("ssh-password-input").inputValue(), "fixture-password");
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/remote-connection.html?auto`);
    await page.waitForFunction(() => window.remoteConnectionFixture.attempts.length === 1);
    assert.equal(
      await page.evaluate(() => window.remoteConnectionFixture.attempts[0].target.host),
      "saved.invalid",
    );
    await page.getByRole("button", { name: "Continue in background", exact: true }).click();
    await page.getByTestId("ssh-connect-trigger").click();
    assert.equal(await page.evaluate(() => window.remoteConnectionFixture.attempts.length), 1);
    await page
      .getByTestId("ssh-dialog")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await page.getByRole("button", { name: /^Stop connecting/ }).click();
    await page.getByTestId("ssh-dialog").waitFor({ state: "detached" });
    await page.evaluate(() => window.remoteConnectionFixture.succeed(0));
    await page.waitForFunction(() => window.remoteConnectionFixture.disposed.includes("session-0"));
  },
);

test(
  "remote connection dialog rejects stale results across SSH, WSL and Docker",
  { timeout: 180_000 },
  async (t) => {
    const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
    async function pageFor(width = 1280) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(10_000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${port}/test/fixtures/remote-connection.html`);
      await page.getByTestId("ssh-connect-trigger").waitFor();
      t.after(async () => {
        await page.close();
        assert.deepEqual(errors, [], diagnostics());
      });
      return page;
    }
    async function start(page, kind) {
      await page.getByTestId("ssh-connect-trigger").click();
      await page.getByTestId(`remote-kind-${kind}`).click();
      if (kind === "ssh") {
        await page.getByTestId("ssh-host-input").fill("example.invalid");
        await page.getByTestId("ssh-username-input").fill("tester");
        await page.getByTestId("ssh-password-input").fill("fixture-password");
      }
      if (kind === "docker")
        await page.getByPlaceholder(/container name or ID/i).fill("test-container");
      await page.getByRole("button", { name: "Start connection", exact: true }).click();
    }
    async function cancel(page) {
      await page
        .getByTestId("ssh-dialog")
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await page.getByRole("button", { name: /^Stop connecting/ }).click();
      await page.getByTestId("ssh-dialog").waitFor({ state: "detached" });
    }
    async function settle(page, index, success) {
      await page.evaluate(
        async ({ index, success }) => {
          const fixture = window.remoteConnectionFixture;
          if (success) fixture.succeed(index);
          else fixture.fail(index);
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        },
        { index, success },
      );
    }
    for (const kind of ["ssh", "wsl", "docker"]) {
      await t.test(
        `${kind}: cancelled failures stay closed and late sessions are released`,
        async () => {
          const page = await pageFor(kind === "docker" ? 390 : 1280);
          await start(page, kind);
          await cancel(page);
          await settle(page, 0, false);
          assert.equal(await page.getByTestId("fixture-open").innerText(), "false");
          await start(page, kind);
          await cancel(page);
          await settle(page, 1, true);
          assert.equal(await page.getByTestId("fixture-open").innerText(), "false");
          assert.deepEqual(await page.evaluate(() => window.remoteConnectionFixture.disposed), [
            "session-1",
          ]);
          assert.equal(
            await page.evaluate(() => window.remoteConnectionFixture.cancelled.length),
            2,
          );
        },
      );
    }
    await t.test(
      "device disconnect ends a minimized directory flow without releasing other sessions",
      async () => {
        const page = await pageFor();
        await start(page, "ssh");
        await settle(page, 0, true);
        await page.getByTestId("ssh-success").waitFor();
        await page.getByRole("button", { name: "Minimize remote connection window" }).click();
        await page.evaluate(() => window.remoteConnectionFixture.dropSession(0));
        await page.getByTestId("ssh-connect-trigger").click();
        await page.getByTestId("ssh-host-input").waitFor();
        assert.equal(await page.getByTestId("ssh-success").count(), 0);
        assert.deepEqual(await page.evaluate(() => window.remoteConnectionFixture.disposed), []);
      },
    );
    await t.test(
      "an old SSH success cannot replace a new WSL connection; normal results still appear",
      async () => {
        const page = await pageFor();
        await start(page, "ssh");
        await cancel(page);
        await start(page, "wsl");
        await settle(page, 0, true);
        assert.equal(await page.getByTestId("ssh-success").count(), 0);
        assert.deepEqual(await page.evaluate(() => window.remoteConnectionFixture.disposed), [
          "session-0",
        ]);
        await settle(page, 1, false);
        await page.getByText("fixture failure 1", { exact: true }).waitFor();
        await page.getByRole("button", { name: "Retry connection", exact: true }).click();
        await settle(page, 2, true);
        await page.getByTestId("ssh-success").waitFor();
      },
    );
    await t.test(
      "closing confirmation releases a session that completed while confirmation was open",
      async () => {
        const page = await pageFor();
        await start(page, "ssh");
        await page
          .getByTestId("ssh-dialog")
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await page.getByRole("button", { name: /^Stop connecting/ }).waitFor();
        await settle(page, 0, true);
        await page.getByRole("button", { name: /^Stop connecting/ }).click();
        await page.getByTestId("ssh-dialog").waitFor({ state: "detached" });
        assert.deepEqual(await page.evaluate(() => window.remoteConnectionFixture.disposed), [
          "session-0",
        ]);
      },
    );
    await t.test(
      "minimizing preserves the active connection and restores its successful result",
      async () => {
        const page = await pageFor();
        await start(page, "wsl");
        await page.getByRole("button", { name: "Minimize remote connection window" }).click();
        await page.getByTestId("ssh-dialog").waitFor({ state: "detached" });
        await settle(page, 0, true);
        await page.getByTestId("ssh-success").waitFor();
        assert.deepEqual(await page.evaluate(() => window.remoteConnectionFixture.cancelled), []);
        assert.deepEqual(await page.evaluate(() => window.remoteConnectionFixture.disposed), []);
      },
    );
  },
);
