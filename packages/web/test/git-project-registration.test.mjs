import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";
test("仓库登记使用真实 Root actions，分组失败重试不重复保存项目", { timeout: 90000 }, async (t) => {
  const { browser, port } = await startWorkflowProgressBrowser(t),
    page = await browser.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const response = await page.goto(
    `http://127.0.0.1:${port}/test/fixtures/project-form.html?registration`,
  );
  await page
    .waitForFunction(() => Boolean(globalThis.__projectCreationActions))
    .catch((error) => {
      throw new Error(JSON.stringify({ errors, url: page.url(), status: response.status() }), {
        cause: error,
      });
    });
  const request = {
    projectId: "f0d43c34-bb90-43f2-8ee6-73b3f2869001",
    name: "仓库项目",
    sourceFolderPaths: ["/fixture/acquired-repository"],
    sidebarSectionId: "tools",
  };
  await page.evaluate(() => globalThis.__sidebarOrganization.failNextGroup());
  const create = () =>
    page.evaluate(async (request) => {
      try {
        await globalThis.__projectCreationActions.create(request);
        return null;
      } catch (e) {
        return e.message;
      }
    }, request);
  assert.match(await create(), /分组|group/i);
  let state = await page.evaluate(() => ({
    settings: globalThis.__sidebarOrganization.settings(),
    calls: globalThis.__sidebarOrganization.calls(),
  }));
  assert.equal(state.settings.localProjects.filter((p) => p.id === request.projectId).length, 1);
  assert.equal(state.calls.filter((c) => c.method === "project").length, 1);
  assert.equal(await create(), null);
  state = await page.evaluate(() => ({
    settings: globalThis.__sidebarOrganization.settings(),
    calls: globalThis.__sidebarOrganization.calls(),
    grouping: globalThis.__sidebarOrganization.grouping(),
  }));
  assert.equal(state.calls.filter((c) => c.method === "project").length, 1);
  assert.equal(state.grouping.sections[0].entries[0].localProjectId, request.projectId);
  const revised = {
    ...request,
    name: "组合项目",
    sourceFolderPaths: [...request.sourceFolderPaths, "/fixture/shared"],
  };
  await page.evaluate(
    async (request) => globalThis.__projectCreationActions.create(request),
    revised,
  );
  state = await page.evaluate(() => ({
    settings: globalThis.__sidebarOrganization.settings(),
    calls: globalThis.__sidebarOrganization.calls(),
  }));
  assert.deepEqual(
    state.settings.localProjects.find((p) => p.id === request.projectId).sourceFolderPaths,
    revised.sourceFolderPaths,
  );
  assert.equal(
    state.settings.localProjects.find((p) => p.id === request.projectId).name,
    revised.name,
  );
  assert.equal(state.calls.filter((c) => c.method === "project").length, 2);
  const duplicate = await page.evaluate(async (request) => {
    try {
      await globalThis.__projectCreationActions.create({
        ...request,
        projectId: crypto.randomUUID(),
      });
      return null;
    } catch (e) {
      return e.message;
    }
  }, request);
  assert.ok(duplicate);
  assert.equal(
    (await page.evaluate(() => globalThis.__sidebarOrganization.calls())).filter(
      (c) => c.method === "project",
    ).length,
    2,
  );
});
