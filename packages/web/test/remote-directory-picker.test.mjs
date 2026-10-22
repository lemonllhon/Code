import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

async function openPicker(
  browser,
  port,
  viewport = { width: 1200, height: 900 },
  query = "",
  english = true,
) {
  const page = await browser.newPage({ viewport });
  await page.goto(
    `http://127.0.0.1:${port}/test/fixtures/project-form.html?mixed${english ? "&english" : ""}${query}`,
  );
  await page
    .getByRole("button", { name: english ? "New project" : "新建项目", exact: true })
    .click();
  const project = page.getByTestId("create-project-dialog");
  await project.getByTestId("project-add-remote-folder").click();
  const picker = page.getByTestId("remote-project-folder-picker");
  return { page, project, picker };
}

async function connect(page, picker, id = "A", english = true) {
  await picker.getByRole("combobox").click();
  await page.getByRole("option", { name: new RegExp(`Device ${id}`) }).click();
  await picker
    .getByRole("button", { name: english ? "Connect device" : "连接设备", exact: true })
    .click();
  await picker
    .getByRole("button", { name: english ? "Add folder" : "添加目录", exact: true })
    .waitFor();
  await page.waitForFunction(
    () =>
      !document.querySelector(
        '[data-testid="remote-project-folder-picker"] [data-testid="remote-folder-confirm"]',
      )?.disabled,
  );
}

test(
  "remote directories: aligned controls, full list, quick navigation, filtering and explicit selection",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const { page, project, picker } = await openPicker(browser, port);
    await picker.getByRole("combobox").focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    assert.match(await picker.getByRole("combobox").innerText(), /Device A/);
    const trigger = await picker.getByRole("combobox").boundingBox();
    const button = await picker
      .getByRole("button", { name: "Connect device", exact: true })
      .boundingBox();
    assert.ok(Math.abs(trigger.y - button.y) < 1);
    assert.ok(Math.abs(trigger.height - button.height) < 1);
    await picker.getByRole("button", { name: "Connect device", exact: true }).click();
    const path = picker.getByRole("textbox", { name: "Folder path or name", exact: true });
    assert.equal(await picker.getByRole("textbox").count(), 1, "path and filter share one input");
    await page.waitForFunction(
      () => document.querySelector('[data-testid="directory-browser-path"]')?.value === "/app",
    );
    const list = picker.getByTestId("directory-browser-list");
    assert.equal(await list.getByRole("button", { name: "README.md", exact: true }).count(), 0);
    await picker.getByRole("button", { name: "File system root", exact: true }).click();
    await list.getByRole("button", { name: "folder-59", exact: true }).waitFor();
    assert.equal(await list.getByRole("button").count(), 62);
    assert.ok(await list.evaluate((node) => node.scrollHeight > node.clientHeight));
    await list.getByRole("button", { name: "folder-59", exact: true }).scrollIntoViewIfNeeded();
    await mkdir(".artifacts/remote-directory-picker", { recursive: true });
    await picker.screenshot({ path: ".artifacts/remote-directory-picker/desktop.png" });
    const callsBeforeFiltering = await page.evaluate(
      () => globalThis.__mixedDirectoryBrowser.calls().length,
    );
    await path.fill("folder-59");
    assert.equal(await list.getByRole("button").count(), 1);
    await path.press("Enter");
    assert.equal(
      await page.evaluate(() => globalThis.__mixedDirectoryBrowser.calls().length),
      callsBeforeFiltering,
      "name filtering does not navigate remotely",
    );
    assert.ok(await picker.getByRole("button", { name: "Add folder", exact: true }).isEnabled());
    await picker.getByRole("button", { name: "Clear input", exact: true }).click();
    assert.equal(await path.inputValue(), "/");
    assert.equal(await list.getByRole("button").count(), 62);
    await path.fill("no-matching-folder");
    await picker.getByText("No matching folders in this directory", { exact: true }).waitFor();
    await path.fill("folder-59");
    await list.getByRole("button", { name: "folder-59", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="directory-browser-path"]')?.value === "/folder-59",
    );
    assert.equal(await path.inputValue(), "/folder-59");
    await picker.getByRole("button", { name: "Parent folder", exact: true }).click();
    await list.getByRole("button", { name: "app", exact: true }).waitFor();
    await picker.getByRole("button", { name: "Home folder", exact: true }).click();
    await list.getByRole("button", { name: "src", exact: true }).waitFor();
    await picker.getByRole("button", { name: "Show hidden directories", exact: true }).click();
    await list.getByRole("button", { name: ".config", exact: true }).waitFor();
    await path.fill("~/projects");
    const confirm = picker.getByRole("button", { name: "Add folder", exact: true });
    assert.ok(await confirm.isDisabled(), "an unsubmitted path cannot confirm the previous folder");
    await picker.getByRole("button", { name: "Go", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="directory-browser-path"]')?.value === "/app/projects",
    );
    await confirm.click();
    await project.locator('[data-project-member="/app/projects"]').waitFor();
  },
);

test(
  "remote directory errors and stale responses cannot confirm an old folder or another device",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const { page, picker } = await openPicker(browser, port);
    await connect(page, picker);
    const path = picker.getByRole("textbox", { name: "Folder path or name", exact: true });
    const confirm = picker.getByRole("button", { name: "Add folder", exact: true });
    await path.fill("/denied");
    await path.press("Enter");
    await picker.getByRole("alert").filter({ hasText: "fixture-permission-denied" }).waitFor();
    assert.ok(await confirm.isDisabled());
    await path.fill("/slow");
    await path.press("Enter");
    await page.waitForFunction(() =>
      globalThis.__mixedDirectoryBrowser.calls().some((call) => call.path === "/slow"),
    );
    await picker.getByRole("combobox").click();
    await page.getByRole("option", { name: /Device B/ }).click();
    await picker.getByRole("button", { name: "Connect device", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="directory-browser-path"]')?.value === "/app",
    );
    await page.evaluate(() => globalThis.__mixedDirectoryBrowser.release("/slow"));
    await confirm.click();
    const member = page
      .getByTestId("create-project-dialog")
      .locator('[data-project-member="/app"]');
    await member.getByText("Device B", { exact: true }).waitFor();
    assert.equal(await member.count(), 1);
  },
);

test(
  "folder picker and source actions fit narrow screens across seven themes",
  { timeout: 180000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const theme of [
      "zai-light",
      "zai-dark",
      "sepia-light",
      "midnight-blue",
      "forest-dark",
      "cinnabar",
      "inkpurple",
    ]) {
      const { page, picker } = await openPicker(
        browser,
        port,
        { width: 390, height: 640 },
        `&theme=${theme}`,
      );
      await connect(page, picker);
      assert.ok(await picker.evaluate((node) => node.scrollWidth <= node.clientWidth));
      const footer = await picker
        .getByRole("button", { name: "Add folder", exact: true })
        .boundingBox();
      assert.ok(footer.y >= 0 && footer.y + footer.height <= 640);
      await picker.getByRole("button", { name: "File system root", exact: true }).click();
      await picker
        .getByTestId("directory-browser-list")
        .getByRole("button", { name: "folder-59", exact: true })
        .scrollIntoViewIfNeeded();
      if (theme === "zai-light") {
        await mkdir(".artifacts/remote-directory-picker", { recursive: true });
        await picker.screenshot({ path: ".artifacts/remote-directory-picker/mobile.png" });
      }
      await picker.getByRole("button", { name: "Back", exact: true }).click();
      const project = page.getByTestId("create-project-dialog");
      for (const id of [
        "project-add-remote-folder",
        "create-project-add-folder",
        "project-git-repository",
      ]) {
        const action = project.getByTestId(id);
        assert.equal(await action.getAttribute("data-variant"), "outline");
        assert.equal(await action.locator("svg").count(), 1);
      }
      if (theme === "zai-light")
        await project.screenshot({
          path: ".artifacts/remote-directory-picker/project-actions.png",
        });
      await page.close();
    }
  },
);

test(
  "remote path navigation preserves Windows drive and UNC share roots",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const home of ["C:\\Users\\dev", "\\\\server\\share\\projects"]) {
      const { page, picker } = await openPicker(
        browser,
        port,
        undefined,
        `&remoteHome=${encodeURIComponent(home)}`,
      );
      await connect(page, picker);
      const path = picker.getByRole("textbox", { name: "Folder path or name", exact: true });
      assert.equal(await path.inputValue(), home);
      await picker.getByRole("button", { name: "Parent folder", exact: true }).click();
      await page.waitForFunction(
        (home) => document.querySelector('[data-testid="directory-browser-path"]')?.value !== home,
        home,
      );
      await picker.getByRole("button", { name: "File system root", exact: true }).click();
      const root = home.startsWith("C:") ? "C:\\" : "\\\\server\\share\\";
      await page.waitForFunction(
        (root) => document.querySelector('[data-testid="directory-browser-path"]')?.value === root,
        root,
      );
      assert.ok(
        await picker.getByRole("button", { name: "Parent folder", exact: true }).isDisabled(),
      );
      await picker.getByRole("button", { name: "Home folder", exact: true }).click();
      await page.waitForFunction(
        (home) => document.querySelector('[data-testid="directory-browser-path"]')?.value === home,
        home,
      );
      await page.close();
    }
  },
);

test(
  "Chinese large text and short landscape keep device controls and footer reachable",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const viewport of [
      { width: 1009, height: 670 },
      { width: 390, height: 640 },
      { width: 844, height: 390 },
    ]) {
      const { page, picker } = await openPicker(
        browser,
        port,
        viewport,
        "&theme=sepia-light",
        false,
      );
      await page.evaluate(() =>
        document.documentElement.style.setProperty("--ui-font-size", "20px"),
      );
      await connect(page, picker, "A", false);
      await picker.getByRole("button", { name: "根目录", exact: true }).click();
      await picker
        .getByTestId("directory-browser-list")
        .getByRole("button", { name: "folder-59", exact: true })
        .scrollIntoViewIfNeeded();
      assert.ok(await picker.evaluate((node) => node.scrollWidth <= node.clientWidth));
      const footer = await picker
        .getByRole("button", { name: "添加目录", exact: true })
        .boundingBox();
      assert.ok(footer.y >= 0 && footer.y + footer.height <= viewport.height);
      const body = picker.locator('[data-slot="dialog-body"]');
      if (viewport.height > 480)
        assert.ok(
          await body.evaluate((node) => node.scrollHeight <= node.clientHeight + 1),
          "only the directory list scrolls on tall screens",
        );
      if (viewport.width === 1009) {
        await mkdir(".artifacts/remote-directory-picker", { recursive: true });
        await picker.getByRole("button", { name: "主目录", exact: true }).click();
        await picker
          .getByTestId("directory-browser-list")
          .getByRole("button", { name: "src", exact: true })
          .waitFor();
        await picker.screenshot({
          path: ".artifacts/remote-directory-picker/chinese-desktop.png",
          animations: "disabled",
        });
        await picker.getByRole("combobox").click();
        await page.getByRole("option", { name: /Device A/ }).waitFor();
        await page.screenshot({
          path: ".artifacts/remote-directory-picker/chinese-device-menu.png",
          animations: "disabled",
        });
        await page.keyboard.press("Escape");
      }
      await picker.getByRole("button", { name: "返回", exact: true }).click();
      const actions = page.getByTestId("project-folder-actions");
      assert.ok(await actions.evaluate((node) => node.scrollWidth <= node.clientWidth));
      if (viewport.width === 1009)
        await page
          .getByTestId("create-project-dialog")
          .screenshot({ path: ".artifacts/remote-directory-picker/chinese-project.png" });
      await page.close();
    }
  },
);
