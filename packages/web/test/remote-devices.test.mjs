import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "zero-project device saving keeps secrets in credentials and replays a lost response",
  { timeout: 60000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/remote-devices.html`);
    await page.getByTestId("remote-device-card").first().waitFor();
    const failed = await page.evaluate(async () => {
      const fixture = globalThis.__remoteDevicesFixture;
      fixture.loseDeviceResponse();
      try {
        await fixture.saveFixtureDevice();
        return false;
      } catch (error) {
        return error.message.includes("lost device save response");
      }
    });
    assert.equal(failed, true);
    await page.evaluate(() => globalThis.__remoteDevicesFixture.saveFixtureDevice());
    const card = page.getByTestId("remote-device-card").filter({ hasText: "zero.invalid" });
    await card.getByText("0 projects", { exact: true }).waitFor();
    assert.equal(await card.locator('[data-device-state="connected"]').count(), 1);
    const saved = await page.evaluate(() => ({
      profiles: globalThis.__remoteDevicesFixture.savedProfiles(),
      credentials: globalThis.__remoteDevicesFixture.credentialCount(),
      saves: globalThis.__remoteDevicesFixture.calls.filter((call) => call.action === "save"),
    }));
    const profile = saved.profiles.find((profile) => profile.id === "fixture-zero");
    assert.equal(profile.revision, 1);
    assert.equal(profile.target.assetInstallMode, "remote-download");
    assert.equal(profile.target.proxyProfileId, "fixture-proxy");
    assert.ok(profile.target.passwordCredentialKey);
    assert.ok(!JSON.stringify(saved.profiles).includes("fixture-device-secret"));
    assert.equal(saved.credentials, 1);
    assert.equal(saved.saves[0].operationId, saved.saves[1].operationId);
    await page.evaluate(() => globalThis.__remoteDevicesFixture.saveFixtureDevice(true));
    assert.equal(
      await page.evaluate(
        () =>
          globalThis.__remoteDevicesFixture
            .savedProfiles()
            .find((profile) => profile.id === "fixture-zero").revision,
      ),
      1,
      "reconnecting never rewrites the profile",
    );
  },
);

test(
  "workspace settings forward device actions through both service-provider branches",
  { timeout: 60000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const branch of ["", "&unscoped"]) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(
        `http://127.0.0.1:${port}/test/fixtures/remote-devices.html?settings${branch}`,
      );
      await page.getByTestId("remote-devices-settings").waitFor();
      const button = page.getByRole("button", { name: "New connection", exact: true });
      assert.equal(await button.isEnabled(), true);
      await button.click();
      await page.waitForFunction(() =>
        globalThis.__remoteDevicesFixture.calls.some((call) => call.action === "new"),
      );
      const navigation = page.getByRole("navigation", { name: "Sections", exact: true });
      const names = await navigation
        .getByRole("button")
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
      assert.equal(names[names.indexOf("Remote control") + 1], "Remote devices");
      assert.deepEqual(errors, []);
      await page.close();
    }
  },
);

test(
  "remote device settings use existing owners for configure, reconnect, disconnect and remove",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/remote-devices.html`);
    const cards = page.getByTestId("remote-device-card");
    await cards.first().waitFor();
    assert.equal(await cards.count(), 3);
    const ssh = cards.filter({ hasText: "example.invalid" });
    assert.equal(await ssh.locator('[data-device-state="connected"]').count(), 1);
    assert.equal(await cards.locator('[data-device-state="offline"]').count(), 1);
    assert.equal(await cards.locator('[data-device-state="failed"]').count(), 1);
    await ssh.getByRole("button", { name: "Configure", exact: true }).click();
    await page.waitForFunction(() =>
      globalThis.__remoteDevicesFixture.calls.some(
        (call) => call.action === "configure" && call.hasPassword && !call.auto,
      ),
    );
    assert.equal(await ssh.getByRole("button", { name: "Open folder", exact: true }).count(), 0);
    await ssh.locator("summary").filter({ hasText: "2 projects" }).click();
    await ssh.getByRole("button", { name: "/one", exact: true }).click();
    await ssh
      .locator("summary")
      .filter({ hasText: /Recent connection logs/ })
      .click();
    await ssh.getByText("12:00:00 Fixture connection ready", { exact: true }).waitFor();
    await mkdir(".artifacts/remote-devices", { recursive: true });
    await page.screenshot({ path: ".artifacts/remote-devices/desktop-dark.png", fullPage: true });
    await ssh.getByRole("button", { name: /^Disconnect/ }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^Cancel/ })
      .click();
    assert.equal(await ssh.locator('[data-device-state="connected"]').count(), 1);
    await ssh.getByRole("button", { name: /^Disconnect/ }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^Disconnect/ })
      .click();
    await ssh.locator('[data-device-state="offline"]').waitFor();
    await page.evaluate(() => globalThis.__remoteDevicesFixture.fail(true));
    await ssh.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("alert").getByText("Fixture reconnect failure", { exact: true }).waitFor();
    await page.evaluate(() => globalThis.__remoteDevicesFixture.fail(false));
    await ssh.getByRole("button", { name: "Connect", exact: true }).click();
    await ssh.locator('[data-device-state="connected"]').waitFor();
    await ssh.getByRole("button", { name: /^Remove device/ }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^Remove device/ })
      .click();
    await ssh.waitFor({ state: "detached" });
    assert.equal(await cards.count(), 2);
    assert.equal(
      await page.evaluate(
        () =>
          globalThis.__remoteDeviceTabs.getState().tabs.filter((tab) => tab.kind === "workspace")
            .length,
      ),
      2,
    );
    const calls = await page.evaluate(() => globalThis.__remoteDevicesFixture.calls);
    assert.equal(calls.find((call) => call.action === "remove").deviceId, "profile-0");
    assert.equal(calls.filter((call) => call.action === "disconnect").length, 2);
    assert.ok(calls.some((call) => call.action === "configure" && call.auto));
    await page.getByRole("button", { name: "New connection", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Search devices or project paths" })
      .fill("no-such-device");
    assert.equal(await cards.count(), 0);
    assert.ok(
      (await page.evaluate(() => globalThis.__remoteDevicesFixture.calls)).some(
        (call) => call.action === "new",
      ),
    );
    assert.deepEqual(errors, []);
    await page.close();

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mobile.goto(`http://127.0.0.1:${port}/test/fixtures/remote-devices.html?zh&light`);
    await mobile.getByTestId("remote-device-card").first().waitFor();
    assert.equal(
      await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await mobile.screenshot({ path: ".artifacts/remote-devices/mobile-light.png", fullPage: true });
  },
);
