import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

export async function runGitWorkspaceCases(t, { page, url }) {
  page.setDefaultTimeout(15000);
  const fixtureUrl = new URL("git-workspace.html", url).href;
  const go = async (query = "") => {
    await page.goto(fixtureUrl + query);
    await page.getByTestId("git-view-stash").click();
    await page.getByTestId("git-stash-entry").waitFor();
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="git-stash-save"]').disabled,
    );
  };
  const action = (method, value) =>
    page.evaluate(({ method, value }) => globalThis.__gitWorkspace[method](value), {
      method,
      value,
    });
  const writes = () =>
    page.evaluate(() =>
      globalThis.__gitWorkspace.calls.filter((call) =>
        [
          "saveStash",
          "applyStash",
          "dropStash",
          "acquireRepository",
          "completeGitOperation",
        ].includes(call.method),
      ),
    );
  const settled = async (count) => {
    await page.waitForFunction(
      (count) =>
        globalThis.__gitWorkspace.calls.filter((call) =>
          [
            "saveStash",
            "applyStash",
            "dropStash",
            "acquireRepository",
            "completeGitOperation",
          ].includes(call.method),
        ).length === count,
      count,
    );
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="git-stash-save"]').disabled,
    );
  };
  await t.test("Stash 入口只读，三个 Diff 分区与保存范围独立确认", async () => {
    await go();
    assert.deepEqual(await writes(), []);
    await page.getByRole("button", { name: "查看 Stash 差异 stash@{0}", exact: true }).click();
    assert.match(
      await page.getByTestId("git-stash-preview").innerText(),
      /暂存区[\s\S]*工作区[\s\S]*未跟踪文件/,
    );
    await page.getByRole("textbox", { name: "Stash 说明（可选）" }).fill("keep my changes");
    await page.getByRole("checkbox", { name: "包含未跟踪文件", exact: true }).check();
    await page.getByTestId("git-stash-save").click();
    assert.match(
      await page.getByTestId("git-stash-confirmation").innerText(),
      /整个仓库[\s\S]*empty.txt/,
    );
    assert.deepEqual(await writes(), []);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    assert.deepEqual(await writes(), []);
    await page.getByTestId("git-stash-save").click();
    await page.getByTestId("git-stash-confirm").click();
    await settled(1);
    const call = (await writes())[0];
    assert.equal(call.params.includeUntracked, true);
    assert.equal(call.params.message, "keep my changes");
    assert.equal(await page.getByTestId("git-stash-entry").count(), 2);
  });
  await t.test("应用保留条目、恢复暂存区可选，删除独立确认，双击只写一次", async () => {
    await go();
    await page.getByRole("checkbox", { name: "应用时同时恢复暂存区" }).check();
    await page.getByRole("button", { name: "应用并保留… stash@{0}", exact: true }).click();
    await page.getByTestId("git-stash-confirm").waitFor();
    await action("hold");
    await page.getByTestId("git-stash-confirm").evaluate((button) => {
      button.click();
      button.click();
    });
    await action("release");
    await settled(1);
    assert.equal((await writes())[0].params.restoreIndex, true);
    assert.equal(await page.getByTestId("git-stash-entry").count(), 1);
    await page.getByRole("button", { name: "删除此 Stash… stash@{0}", exact: true }).click();
    assert.match(await page.getByTestId("git-stash-confirmation").innerText(), /仅删除这一条/);
    await page.getByTestId("git-stash-confirm").click();
    await settled(2);
    assert.equal(await page.getByTestId("git-stash-entry").count(), 0);
  });
  await t.test("真实冲突事实显示并阻止保存，外部解决后显式检查完成", async () => {
    await go();
    await action("conflict", true);
    await page.getByRole("button", { name: "应用并保留… stash@{0}", exact: true }).click();
    await page.getByTestId("git-stash-confirm").click();
    await page.getByTestId("git-operation-recovery").waitFor();
    assert.equal(await page.getByTestId("git-stash-save").isDisabled(), true);
    assert.match(
      await page.getByTestId("git-workspace-receipt").innerText(),
      /src\/app.ts.*1\/2\/3/,
    );
    await page.getByRole("button", { name: "检查处理结果", exact: true }).click();
    assert.equal(await page.getByTestId("git-operation-complete").isDisabled(), true);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await action("conflict", false);
    await page.getByRole("button", { name: "检查处理结果", exact: true }).click();
    await page.getByTestId("git-operation-complete").click();
    await settled(2);
    assert.equal(await page.getByTestId("git-operation-recovery").count(), 0);
  });
  await t.test("丢失回执只查询原请求，刷新不重放；换 Host 使迟到预览失效", async () => {
    await go();
    await action("lostAck");
    await page.getByRole("button", { name: "应用并保留… stash@{0}", exact: true }).click();
    await page.getByTestId("git-stash-confirm").click();
    await page.getByTestId("git-workspace-error").waitFor();
    await page.getByRole("button", { name: "刷新本地状态", exact: true }).click();
    await page.getByTestId("git-workspace-receipt").waitFor();
    assert.equal((await writes()).length, 1);
    await action("hold");
    await page.getByTestId("git-stash-save").click();
    await action("remote");
    await action("release");
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="git-stash-save"]').disabled,
    );
    assert.equal(await page.getByTestId("git-stash-confirmation").count(), 0);
    await page.getByTestId("git-stash-save").click();
    await page.getByTestId("git-stash-confirm").click();
    await settled(2);
    assert.equal((await writes())[1].host, "remote");
    assert.equal((await writes())[1].params.workspaceIdentity, "fixture:remote");
    await action("disconnect");
    await page.waitForFunction(
      () => document.querySelector('[data-testid="git-stash-save"]').disabled,
    );
  });
  const importForm = async (mode = "clone") => {
    await page.goto(fixtureUrl);
    await page.getByTestId("composer-workspace-trigger").click();
    await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
    await page.getByRole("textbox", { name: "项目名称", exact: true }).fill("导入项目");
    await page.getByTestId("project-git-repository").click();
    if (mode === "init")
      await page.getByRole("button", { name: "初始化仓库", exact: true }).click();
    await page.getByTestId("git-repository-next").click();
    await page.getByRole("textbox", { name: "目录路径", exact: true }).fill("/fixture/import");
    await page.getByTestId("git-repository-next").click();
  };
  await t.test("项目内克隆向导预览失效与确认，成功后添加源目录再保存项目", async () => {
    await importForm();
    await page
      .getByRole("textbox", { name: "仓库地址", exact: true })
      .fill("https://example.invalid/repo.git");
    await page.getByRole("textbox", { name: "新目录名称", exact: true }).fill("cloned");
    await page.getByTestId("git-repository-next").click();
    await page.getByTestId("git-import-confirmation").waitFor();
    assert.deepEqual(await writes(), []);
    await page.getByTestId("git-repository-back").click();
    await page.getByRole("textbox", { name: "新目录名称", exact: true }).fill("changed");
    assert.equal(await page.getByTestId("git-import-confirmation").count(), 0);
    await page.getByTestId("git-repository-next").click();
    await page.getByTestId("git-import-confirm").click();
    await page.getByTestId("git-repository-wizard").waitFor({ state: "detached" });
    await page.getByTestId("create-project-submit").click();
    await page.waitForFunction(() =>
      document
        .querySelector('[data-testid="project-created"]')
        .textContent.includes("/fixture/import/changed"),
    );
    assert.equal((await writes()).length, 1);
  });
  await t.test("克隆丢回执后查询并使用原目录，不发起第二次克隆", async () => {
    await importForm();
    await page
      .getByRole("textbox", { name: "仓库地址", exact: true })
      .fill("https://example.invalid/repo.git");
    await page.getByRole("textbox", { name: "新目录名称", exact: true }).fill("original");
    await page.getByTestId("git-repository-next").click();
    await action("lostAck");
    await page.getByTestId("git-import-confirm").click();
    await page.getByTestId("git-workspace-error").waitFor();
    await page.getByRole("button", { name: "查询原请求结果", exact: true }).click();
    await page.getByTestId("git-repository-attach").click();
    await page.getByTestId("git-repository-wizard").waitFor({ state: "detached" });
    await page.getByTestId("create-project-submit").click();
    assert.match(await page.getByTestId("project-created").innerText(), /original/);
    assert.equal((await writes()).length, 1);
  });
  await t.test("unknown 恢复必须核对进程后才能解除写入限制", async () => {
    await go();
    await action("unknown");
    await page.getByRole("button", { name: "应用并保留… stash@{0}", exact: true }).click();
    await page.getByTestId("git-stash-confirm").click();
    await page.getByRole("button", { name: "检查处理结果", exact: true }).click();
    assert.equal(await page.getByTestId("git-operation-complete").isDisabled(), true);
    await page
      .getByRole("checkbox", {
        name: "我已核对原生 Git 进程已结束，并检查实际目录与文件结果。",
        exact: true,
      })
      .check();
    await page.getByTestId("git-operation-complete").click();
    await settled(2);
    assert.equal((await writes())[1].params.confirmNativeStopped, true);
  });
  await t.test("嵌套初始化需明确选择，改选项必须重新预览", async () => {
    await importForm("init");
    await action("nested");
    await page.getByTestId("git-repository-next").click();
    await page.getByTestId("git-import-confirm").waitFor();
    assert.equal(await page.getByTestId("git-import-confirm").isDisabled(), true);
    await page.getByTestId("git-repository-back").click();
    await page.getByRole("checkbox", { name: "明确允许在已有仓库内创建嵌套仓库" }).check();
    assert.equal(await page.getByTestId("git-import-confirm").count(), 0);
    await page.getByTestId("git-repository-next").click();
    await page.getByTestId("git-import-confirm").click();
    await page.getByTestId("git-repository-wizard").waitFor({ state: "detached" });
    assert.equal((await writes())[0].params.options.allowNested, true);
  });
  await t.test("390px 中英文浅暗主题无横向溢出，操作可达", async () => {
    await mkdir("artifacts/git-workspace", { recursive: true });
    for (const query of ["", "?english&dark"]) {
      await page.setViewportSize({ width: 390, height: 844 });
      await go(query);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const name = query ? "Apply and keep… stash@{0}" : "应用并保留… stash@{0}";
      await page.getByRole("button", { name, exact: true }).focus();
      assert.equal(
        await page
          .getByRole("button", { name, exact: true })
          .evaluate((node) => node === document.activeElement),
        true,
      );
      await page.screenshot({
        path: `artifacts/git-workspace/${query ? "english-dark" : "chinese-light"}.png`,
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  });
}
