import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";
import { buildRemoteWorkspaceIdentity } from "../../shared/src/remote-workspace-identity.ts";

test(
  "explicit remote project removal uses the same registry owner and preserves the local project",
  { timeout: 60000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage();
    const workspaceIdentity = buildRemoteWorkspaceIdentity("/srv/app", {
      kind: "ssh",
      host: "device.example.test",
      username: "dev",
    });
    await page.addInitScript((workspaceIdentity) => {
      const local = {
        id: "local",
        name: "Local",
        primaryFolderPath: "/srv/app",
        sourceFolderPaths: ["/srv/app"],
      };
      const remote = {
        id: "remote",
        name: "Remote",
        primaryFolderPath: "/srv/app",
        sourceFolderPaths: ["/srv/app"],
        workspaceIdentity,
        revision: 1,
      };
      localStorage.setItem(
        "sidebar-fixture-projects",
        JSON.stringify({
          localProjects: [local],
          projectDefinitions: { version: 1, projects: [local, remote] },
        }),
      );
    }, workspaceIdentity);
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/project-form.html?registration`);
    await page.waitForFunction(() => Boolean(globalThis.__projectCreationActions));
    await page.evaluate(async () => {
      const request = {
        projectId: "remote",
        workspacePath: "/srv/app",
      };
      await globalThis.__projectCreationActions.remove(request);
      await globalThis.__projectCreationActions.remove(request);
    });
    const state = await page.evaluate(() => globalThis.__sidebarOrganization.settings());
    assert.deepEqual(
      state.projectDefinitions.projects.map((project) => project.id),
      ["local"],
    );
    assert.deepEqual(
      state.localProjects.map((project) => project.id),
      ["local"],
    );
    const mutations = await page.evaluate(() =>
      globalThis.__sidebarOrganization.calls().filter((call) => call.method === "project"),
    );
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].params.type, "remove");
    assert.equal(mutations[0].params.projectId, "remote");
  },
);

test(
  "mixed project menu keeps the logical name, source badge and remote attachment at desktop and mobile widths",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const [width, english] of [
      [1280, false],
      [390, true],
    ]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      t.after(() => page.close());
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(
        `http://127.0.0.1:${port}/test/fixtures/project-form.html?mixedMenu${english ? "&english" : ""}`,
      );
      const badge = english ? "Local + remote" : "本地 + 远程";
      const trigger = page.getByTestId("composer-workspace-trigger");
      await trigger.waitFor();
      assert.match(await trigger.innerText(), /Unified project/);
      assert.ok((await trigger.innerText()).includes(badge));
      await trigger.click();
      assert.equal(
        await page.getByRole("menuitemcheckbox", { name: new RegExp(`Unified project`) }).count(),
        1,
      );
      assert.equal(await page.getByRole("menuitemcheckbox", { name: /remote-folder/ }).count(), 0);
      await page.getByRole("menuitemcheckbox", { name: /Unified project/ }).click();
      const selected = JSON.parse(await page.getByTestId("selected-project").innerText());
      assert.equal(selected.localProjectId, "mixed");
      assert.equal(selected.remoteSessionId, "attachment");
      assert.equal(selected.projectSourceKind, "mixed");
      assert.ok(selected.workspaceIdentity.includes("device.example.test"));
      await page.getByRole("textbox", { name: "Project name" }).fill("Renamed project");
      assert.match(await trigger.innerText(), /Renamed project/);
      await trigger.click();
      assert.equal(
        await page.getByRole("menuitemcheckbox", { name: /Renamed project/ }).count(),
        1,
      );
      assert.equal(
        await page.getByRole("menuitemcheckbox", { name: /Unified project/ }).count(),
        0,
      );
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      if (width === 390) {
        await mkdir(".artifacts/mixed-project", { recursive: true });
        await page.evaluate(async () => {
          await Promise.all(
            document
              .getAnimations()
              .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
              .map((animation) => animation.finished.catch(() => {})),
          );
        });
        await page.screenshot({ path: ".artifacts/mixed-project/logical-project-menu-mobile.png" });
      }
    }
  },
);
