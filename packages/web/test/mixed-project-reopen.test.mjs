import assert from "node:assert/strict";
import test from "node:test";
import { buildRemoteWorkspaceIdentity } from "../../shared/src/remote-workspace-identity.ts";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "a mixed project's explicit double-click restores its saved device after reload, waits for ready and retries failures",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const remoteOrigin of [false, true]) {
      const page = await browser.newPage({
        viewport: { width: remoteOrigin ? 390 : 1280, height: 850 },
      });
      t.after(() => page.close());
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const path = "/fixture/repo";
      const target = { kind: "ssh", host: "example.invalid", username: "fixture", port: 22 };
      const identity = buildRemoteWorkspaceIdentity(path, target);
      await page.addInitScript(
        ({ path, target, identity, remoteOrigin }) => {
          const project = {
            id: remoteOrigin ? "remote-project" : "project",
            name: "Mixed reopen",
            revision: 1,
            primaryFolderPath: path,
            sourceFolderPaths: [path],
            primaryMemberId: remoteOrigin ? "remote" : "local",
            ...(remoteOrigin ? { workspaceIdentity: identity } : {}),
            members: [
              {
                id: "local",
                path,
                label: "",
                role: "",
                description: "",
                enabled: true,
                source: { kind: "local" },
              },
              {
                id: "remote",
                path,
                label: "",
                role: "",
                description: "",
                enabled: true,
                source: { kind: "remote", deviceId: "device", workspaceIdentity: identity },
              },
            ],
          };
          localStorage.setItem(
            "sidebar-fixture-projects",
            JSON.stringify({
              localProjects: [project],
              projectDefinitions: { version: 1, projects: [project] },
              remoteDevices: {
                version: 1,
                devices: [{ id: "device", name: "Saved device", revision: 1, target }],
              },
              recentProjects: [path],
              remoteWorkspaceSessions: [],
            }),
          );
        },
        { path, target, identity, remoteOrigin },
      );
      await page.goto(
        `http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html?prepare-project&project-lifecycle&desktop`,
      );
      const row = page
        .locator('[data-testid^="workspace-item-"]')
        .filter({ hasText: "Mixed reopen", has: page.locator('[data-project-source="mixed"]') });
      await row.waitFor();
      assert.equal(
        await page.evaluate(() => globalThis.__sidebarOrganization.facts.connects),
        0,
        "startup must not connect automatically",
      );
      await page.reload();
      await row.waitFor();
      assert.equal(await page.evaluate(() => globalThis.__sidebarOrganization.facts.connects), 0);
      await page.evaluate(() => globalThis.__sidebarOrganization.projectPreparation.hold());
      await row.dblclick();
      assert.equal(await row.getAttribute("aria-busy"), "true");
      assert.equal(await page.evaluate(() => globalThis.__sidebarOrganization.facts.drafts), 0);
      await row.dblclick();
      assert.equal(await page.evaluate(() => globalThis.__sidebarOrganization.facts.connects), 1);
      await page.evaluate(() => globalThis.__sidebarOrganization.projectPreparation.release());
      await page.waitForFunction(() => globalThis.__sidebarOrganization.facts.drafts === 1);
      await page.waitForFunction(() =>
        document.querySelector('[aria-label="Mixed reopen"][aria-busy="false"]'),
      );
      assert.equal(await row.locator('[data-project-source="mixed"] svg').count(), 2);
      await page.evaluate(() => {
        globalThis.__sidebarOrganization.projectPreparation.disconnect();
        globalThis.__sidebarOrganization.projectPreparation.fail(true);
      });
      await row.dblclick();
      await page.waitForFunction(() =>
        document.querySelector('[aria-label="Mixed reopen"][aria-busy="false"]'),
      );
      assert.equal(
        await page.evaluate(() => globalThis.__sidebarOrganization.facts.drafts),
        1,
        "failed preparation cannot navigate or create a draft",
      );
      await page.evaluate(() => globalThis.__sidebarOrganization.projectPreparation.fail(false));
      await row.dblclick();
      await page.waitForFunction(() => globalThis.__sidebarOrganization.facts.drafts === 2);
      assert.equal(await page.evaluate(() => globalThis.__sidebarOrganization.facts.connects), 3);
      assert.deepEqual(errors, []);
    }
  },
);
