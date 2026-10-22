import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "create mixed folders on two devices at the same path, preserve draft through settings, save and edit primary",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/project-form.html?mixed`);
    await page.evaluate(() =>
      globalThis.__sidebarOrganization.selectCreationBatch(["/fixture/local"]),
    );
    await page.getByRole("button", { name: "新建项目", exact: true }).click();
    let dialog = page.getByTestId("create-project-dialog");
    await dialog.getByTestId("create-project-add-folder").click();
    await dialog.getByLabel("项目名称", { exact: true }).fill("混合设备项目");
    for (const id of ["A", "B"]) {
      await dialog.getByTestId("project-add-remote-folder").click();
      const picker = page.getByTestId("remote-project-folder-picker");
      if (id === "A") {
        await picker.getByRole("button", { name: /管理远程设备/ }).click();
        await page
          .getByTestId("mixed-device-settings")
          .getByRole("button", { name: "返回项目配置" })
          .click();
      }
      await picker.getByRole("combobox").click();
      await page.getByRole("option", { name: `Device ${id}`, exact: false }).click();
      await picker.getByRole("button", { name: "连接设备", exact: true }).click();
      await picker.getByRole("button", { name: "添加目录", exact: true }).click();
      dialog = page.getByTestId("create-project-dialog");
      await dialog.getByText(`Device ${id}`, { exact: true }).waitFor();
    }
    assert.equal(await dialog.locator("[data-project-member='/app']").count(), 2);
    assert.equal(await dialog.getByLabel("项目名称", { exact: true }).inputValue(), "混合设备项目");
    await dialog.getByTestId("create-project-submit").click();
    await dialog.waitFor({ state: "hidden" });
    const saved = await page.evaluate(() =>
      globalThis.__sidebarOrganization
        .settings()
        .projectDefinitions.projects.find((project) => project.name === "混合设备项目"),
    );
    assert.equal(saved.members.length, 3);
    assert.deepEqual(saved.sourceFolderPaths, ["/fixture/local"]);
    assert.deepEqual(
      saved.members.slice(1).map((member) => member.source.deviceId),
      ["A", "B"],
    );
    await page.reload();
    await page.getByText("混合设备项目", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: /编辑项目/ }).click();
    const edit = page.getByTestId("sidebar-project-editor");
    const remoteB = edit.locator("[data-project-member='/app']").filter({ hasText: "Device B" });
    await remoteB.getByRole("button", { name: /设为主文件夹/ }).click();
    assert.equal(
      await edit
        .locator("[data-project-member]")
        .first()
        .getByText("Device B", { exact: true })
        .count(),
      1,
    );
    await edit.getByRole("button", { name: "保存", exact: true }).click();
    await edit.waitFor({ state: "hidden" });
    const changed = await page.evaluate(() =>
      globalThis.__sidebarOrganization
        .settings()
        .projectDefinitions.projects.find((project) => project.name === "混合设备项目"),
    );
    assert.equal(
      changed.members.find((member) => member.id === changed.primaryMemberId).source.deviceId,
      "B",
    );
    assert.equal(changed.primaryFolderPath, "/fixture/local");
  },
);

test(
  "mobile remote-only project rejects invalid folders and cancels without appending",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(
      `http://127.0.0.1:${port}/test/fixtures/project-form.html?mixed&english&theme=zai-light`,
    );
    await page.getByRole("button", { name: "New project", exact: true }).click();
    let dialog = page.getByTestId("create-project-dialog");
    await dialog.getByTestId("create-project-name").fill("Remote only");
    await dialog.getByTestId("project-add-remote-folder").click();
    let picker = page.getByTestId("remote-project-folder-picker");
    await picker.getByRole("combobox").click();
    await page.getByRole("option", { name: /Device A/ }).click();
    await picker.getByRole("button", { name: "Connect device", exact: true }).click();
    await picker
      .getByRole("textbox", { name: "Folder path or name", exact: true })
      .fill("/invalid");
    await picker.getByRole("textbox", { name: "Folder path or name", exact: true }).press("Enter");
    await picker.getByRole("button", { name: "Add folder", exact: true }).click();
    await picker.getByRole("alert").filter({ hasText: "Target is not a directory" }).waitFor();
    await picker.getByRole("button", { name: "Back", exact: true }).click();
    dialog = page.getByTestId("create-project-dialog");
    assert.equal(await dialog.locator("[data-project-member]").count(), 0);
    assert.equal(await dialog.getByTestId("create-project-name").inputValue(), "Remote only");
    await dialog.getByTestId("project-add-remote-folder").click();
    picker = page.getByTestId("remote-project-folder-picker");
    await picker.getByRole("combobox").click();
    await page.getByRole("option", { name: /Device B/ }).click();
    await picker.getByRole("button", { name: "Connect device", exact: true }).click();
    await picker.getByRole("button", { name: "Add folder", exact: true }).click();
    dialog = page.getByTestId("create-project-dialog");
    await dialog.getByText("Device B", { exact: true }).waitFor();
    assert.equal(await dialog.locator("[data-project-member]").count(), 1);
    assert.ok(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth));
    await mkdir(".artifacts/mixed-project", { recursive: true });
    await dialog.evaluate(async (element) => {
      await Promise.allSettled(
        element
          .getAnimations({ subtree: true })
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished),
      );
    });
    await page.screenshot({ path: ".artifacts/mixed-project/mobile.png" });
    await dialog.getByTestId("create-project-submit").click();
    await dialog.waitFor({ state: "hidden" });
    const saved = await page.evaluate(() =>
      globalThis.__sidebarOrganization
        .settings()
        .projectDefinitions.projects.find((project) => project.name === "Remote only"),
    );
    assert.equal(saved.members[0].source.deviceId, "B");
    assert.equal(saved.workspaceIdentity, saved.members[0].source.workspaceIdentity);
  },
);
