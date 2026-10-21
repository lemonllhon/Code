import assert from "node:assert/strict";
import { runGitAccountAuthorizationCases } from "./git-account-authorization-cases.mjs";
import { runGitSystemAccountCases } from "./git-system-account-cases.mjs";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test("Git 管理、账号及向导共享认证", { timeout: 180000 }, async (t) => {
  const { browser, port } = await startWorkflowProgressBrowser(t),
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const base = `http://127.0.0.1:${port}/test/fixtures/git-workspace.html`;
  const fill = async (name, value) => page.getByRole("textbox", { name, exact: true }).fill(value);
  const snapshot = () => page.evaluate(() => globalThis.__gitWorkspace.management.snapshot());
  await t.test("配置检测、四类账号增改删、冲突保留编辑", async () => {
    await page.goto(base + "?management");
    await page.getByRole("button", { name: "检测 Git 路径", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="git-binary-path"]')?.value === "/fixture/bin/git",
    );
    await fill("提交者姓名", "本机用户");
    await fill("提交者邮箱", "fixture@example.invalid");
    await page.getByRole("button", { name: "保存 Git 配置", exact: true }).click();
    await page.waitForFunction(
      () => globalThis.__gitWorkspace.management.snapshot().configuration.userName === "本机用户",
    );
    for (const [provider, server, name] of [
      ["github", "https://github.com", "GitHub 工作"],
      ["gitlab", "https://gitlab.example.invalid", "自建 GitLab"],
      ["gitea", "https://forgejo.example.invalid", "Forgejo"],
      ["server", "https://git.example.invalid", "自建 Git"],
    ]) {
      await page
        .getByRole("tab", {
          name:
            provider === "github"
              ? "GitHub 账号"
              : provider === "gitlab"
                ? "GitLab 账号"
                : provider === "gitea"
                  ? "Gitea / Forgejo 账号"
                  : "Git 服务器账号",
          exact: true,
        })
        .click();
      await page.getByRole("button", { name: "添加账号", exact: true }).click();
      if (provider === "github") await fill("提交者姓名", "尚未保存的姓名");
      await fill("账号名称", name);
      await fill("服务器地址", server);
      await fill("用户名", "fixture");
      await page.getByLabel("访问令牌", { exact: true }).fill("fixture-ui-token");
      await page.getByRole("button", { name: "保存账号", exact: true }).click();
      await page.getByTestId("git-account-editor").waitFor({ state: "detached" });
      assert.equal(
        await page.getByRole("textbox", { name: "提交者姓名", exact: true }).inputValue(),
        "尚未保存的姓名",
      );
      await page.getByRole("button", { name: "修改 " + name, exact: true }).click();
      assert.equal(await page.getByLabel("访问令牌", { exact: true }).inputValue(), "");
      await fill("账号名称", name + " 已修改");
      if (provider === "github") {
        await page.evaluate(() => globalThis.__gitWorkspace.management.conflict());
        await page.getByRole("button", { name: "保存账号", exact: true }).click();
        await page
          .getByRole("alert")
          .getByText(/配置已被其他窗口修改/)
          .waitFor();
        assert.equal(
          await page.getByRole("textbox", { name: "账号名称", exact: true }).inputValue(),
          name + " 已修改",
        );
        await page.getByRole("button", { name: "重新读取", exact: true }).click();
        await page.getByRole("alert").waitFor({ state: "detached" });
      }
      await page.getByRole("button", { name: "保存账号", exact: true }).click();
      await page.getByTestId("git-account-editor").waitFor({ state: "detached" });
      if (provider !== "github") {
        await page.getByRole("button", { name: "删除 " + name + " 已修改", exact: true }).click();
        await page.getByRole("button", { name: "删除", exact: true }).click();
        await page
          .getByRole("button", { name: "删除 " + name + " 已修改", exact: true })
          .waitFor({ state: "detached" });
      }
    }
    assert.equal((await snapshot()).accounts.length, 1);
    assert.ok(!JSON.stringify(await snapshot()).includes("fixture-ui-token"));
  });
  await t.test("检测 SSH 导入，向导只显示匹配账号且请求不带令牌", async () => {
    await page.getByRole("button", { name: "检测本机账号", exact: true }).click();
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await page.waitForFunction(
      () => globalThis.__gitWorkspace.management.snapshot().accounts.length === 2,
    );
    await page.getByTestId("git-settings-toggle").click();
    await page.getByTestId("composer-workspace-trigger").click();
    await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
    await fill("项目名称", "认证仓库");
    await page.getByTestId("project-git-repository").click();
    await page.getByTestId("git-repository-next").click();
    await fill("目录路径", "/fixture/import");
    await page.getByTestId("git-repository-next").click();
    await fill("仓库地址", "https://github.com/fixture/repository.git");
    await fill("新目录名称", "authenticated");
    const picker = page.getByTestId("git-repository-account");
    await picker
      .getByRole("option", { name: "GitHub 工作 已修改 · fixture", exact: true })
      .waitFor({ state: "attached" });
    // 新规则：默认项、已保存 GitHub 和两个本机检测 GitHub；SSH/其他服务器不得混入。
    assert.equal(await picker.getByRole("option").count(), 4);
    assert.equal(await picker.locator('option[value^="detected:"]').count(), 2);
    await picker.selectOption({ label: "GitHub 工作 已修改 · fixture" });
    await page.getByTestId("git-repository-next").click();
    await page.getByTestId("git-import-confirm").click();
    await page.getByTestId("git-repository-wizard").waitFor({ state: "detached" });
    const requests = await page.evaluate(() =>
      globalThis.__gitWorkspace.calls.filter((c) => c.method === "acquireRepository"),
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].params.options.authentication.id, (await snapshot()).accounts[0].id);
    assert.ok(!JSON.stringify(requests).includes("fixture-ui-token"));
  });
  await t.test("Git 配置按卡片宽度对齐换行，姓名和分支紧凑、邮箱较长", async () => {
    await mkdir("artifacts/git-management-layout", { recursive: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const english of [false, true]) {
      await page.goto(base + (english ? "?management&native&dark&english" : "?management&native"));
      const names = english
        ? ["Commit author name", "Commit author email", "Default initial branch"]
        : ["提交者姓名", "提交者邮箱", "默认初始分支"];
      const inputs = names.map((name) => page.getByRole("textbox", { name, exact: true }));
      await inputs[0].waitFor();
      const boxes = await Promise.all(inputs.map((input) => input.boundingBox()));
      const save = await page
        .getByRole("button", {
          name: english ? "Save Git configuration" : "保存 Git 配置",
          exact: true,
        })
        .boundingBox();
      const bottom = (box) => box.y + box.height;
      assert.ok(
        boxes.every((box) => Math.abs(bottom(box) - bottom(boxes[0])) <= 1),
        JSON.stringify(boxes),
      );
      assert.ok(Math.abs(bottom(save) - bottom(boxes[0])) <= 1);
      assert.ok(boxes[0].width >= 176 && boxes[0].width <= 224);
      assert.ok(boxes[1].width >= 256 && boxes[1].width <= 320);
      assert.ok(boxes[2].width >= 144 && boxes[2].width <= 192);
      const path = await page.getByTestId("git-binary-path").boundingBox();
      for (const name of english
        ? [
            "Choose Git executable",
            "Open Git file location",
            "Detect Git path",
            "Use automatic detection",
          ]
        : ["选择 Git 可执行文件", "打开 Git 所在位置", "检测 Git 路径", "使用自动检测"]) {
        const action = await page.getByRole("button", { name, exact: true }).boundingBox();
        assert.ok(Math.abs(bottom(path) - bottom(action)) <= 1);
      }
      await page.screenshot({
        path: `artifacts/git-management-layout/${english ? "desktop-dark-english" : "desktop-light"}.png`,
        fullPage: true,
      });
      const section = page.getByTestId("git-management-section");
      await section.evaluate((node) => (node.style.width = "600px"));
      const wrapped = await Promise.all(inputs.map((input) => input.boundingBox()));
      assert.ok(wrapped[2].y > wrapped[0].y, "narrow card must wrap within a wide window");
      assert.ok(await section.evaluate((node) => node.scrollWidth <= node.clientWidth + 1));
      await section.evaluate((node) => (node.style.width = "460px"));
      const compact = await Promise.all(inputs.map((input) => input.boundingBox()));
      assert.ok(compact[1].y > compact[0].y && compact[2].y > compact[1].y);
      assert.ok(compact.every((box) => Math.abs(box.width - compact[0].width) <= 1));
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base + "?management&dark&english");
    await page.evaluate(() => document.documentElement.style.setProperty("--ui-font-size", "20px"));
    const name = page.getByRole("textbox", { name: "Commit author name", exact: true });
    await name.fill("Keyboard author");
    await name.press("Tab");
    await page.keyboard.type("keyboard@example.invalid");
    await page.keyboard.press("Tab");
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("feature/keyboard");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () =>
        globalThis.__gitWorkspace.management.snapshot().configuration.initialBranch ===
        "feature/keyboard",
    );
    assert.equal((await snapshot()).configuration.userEmail, "keyboard@example.invalid");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({
      path: "artifacts/git-management-layout/mobile-large-font.png",
      fullPage: true,
    });
  });
  await t.test("Git 自动路径直接显示，文件选择/取消/打开及切回自动保持配置语义", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(base + "?management&native");
    const input = page.getByTestId("git-binary-path");
    await page.waitForFunction(
      () => document.querySelector('[data-testid="git-binary-path"]')?.value === "/fixture/bin/git",
    );
    assert.equal((await snapshot()).configuration.binaryPath, "");
    await page.getByRole("button", { name: "打开 Git 所在位置", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => globalThis.__gitWorkspace.openedGitPaths()), [
      "/fixture/bin",
    ]);
    await page.getByRole("button", { name: "选择 Git 可执行文件", exact: true }).click();
    assert.equal(await input.inputValue(), "/fixture/custom/git");
    assert.equal((await snapshot()).configuration.binaryPath, "", "choosing does not save");
    await page.getByRole("button", { name: "保存 Git 配置", exact: true }).click();
    await page.waitForFunction(
      () =>
        globalThis.__gitWorkspace.management.snapshot().configuration.binaryPath ===
        "/fixture/custom/git",
    );
    await page.evaluate(() => globalThis.__gitWorkspace.selectedGitFile(null));
    await page.getByRole("button", { name: "选择 Git 可执行文件", exact: true }).click();
    assert.equal(await input.inputValue(), "/fixture/custom/git");
    await page.getByRole("button", { name: "检测 Git 路径", exact: true }).click();
    assert.equal(
      await input.inputValue(),
      "/fixture/custom/git",
      "detection must preserve custom input",
    );
    for (const [file, directory] of [
      ["C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files\\Git\\cmd"],
      ["C:\\git.exe", "C:\\"],
      ["\\\\server\\share\\git.exe", "\\\\server\\share"],
      ["/git", "/"],
    ]) {
      await page.evaluate((value) => globalThis.__gitWorkspace.selectedGitFile(value), file);
      await page.getByRole("button", { name: "选择 Git 可执行文件", exact: true }).click();
      await page.getByRole("button", { name: "打开 Git 所在位置", exact: true }).click();
      assert.equal(
        await page.evaluate(() => globalThis.__gitWorkspace.openedGitPaths().at(-1)),
        directory,
      );
    }
    await page.getByRole("button", { name: "使用自动检测", exact: true }).click();
    assert.equal(await input.inputValue(), "/fixture/bin/git");
    await page.getByRole("button", { name: "保存 Git 配置", exact: true }).click();
    await page.waitForFunction(
      () => globalThis.__gitWorkspace.management.snapshot().configuration.binaryPath === "",
    );
    await page.evaluate(() => globalThis.__gitWorkspace.failGitPicker());
    await page.getByRole("button", { name: "选择 Git 可执行文件", exact: true }).click();
    await page
      .getByRole("alert")
      .getByText("选择 Git 文件失败，请重试或手动填写。", { exact: true })
      .waitFor();
    await input.fill("/fixture/missing/git");
    await page.getByRole("button", { name: "打开 Git 所在位置", exact: true }).click();
    await page
      .getByRole("alert")
      .getByText("无法打开 Git 所在位置，请检查路径。", { exact: true })
      .waitFor();
    await input.fill("");
    assert.equal(await input.inputValue(), "");
    await input.press("Tab");
    assert.equal(await input.inputValue(), "/fixture/bin/git");
    await page.goto(base + "?management");
    assert.equal(
      await page.getByRole("button", { name: "选择 Git 可执行文件", exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await page.getByRole("button", { name: "打开 Git 所在位置", exact: true }).isDisabled(),
      true,
    );
  });
  await t.test("自动识别的双 GitHub 账号及其他平台候选按页签展示，导入保留选择", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(base + "?management");
    const candidates = page.getByTestId("git-detected-account");
    await candidates.filter({ hasText: "bob · github.com" }).waitFor();
    assert.equal(await candidates.count(), 2);
    assert.equal((await snapshot()).accounts.length, 0);
    await candidates
      .filter({ hasText: "bob · github.com" })
      .getByRole("button", { name: "导入", exact: true })
      .click();
    await page.getByRole("button", { name: "修改 bob · github.com", exact: true }).waitFor();
    assert.equal((await snapshot()).accounts[0].username, "bob");
    assert.equal((await snapshot()).accounts[0].auth, "system");
    assert.equal(await candidates.count(), 1);
    for (const [tab, name] of [
      ["GitLab 账号", "自建 GitLab"],
      ["Gitea / Forgejo 账号", "Forgejo 本机"],
      ["Git 服务器账号", "SSH 工作账号"],
    ]) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      assert.equal(await candidates.count(), 1);
      assert.ok((await candidates.textContent()).includes(name));
    }
    await page.getByRole("textbox", { name: "提交者姓名", exact: true }).fill("检测期间保留草稿");
    await page.evaluate(() => globalThis.__gitWorkspace.management.holdDetection());
    await page.getByRole("button", { name: "检测本机账号", exact: true }).click();
    await page.getByRole("button", { name: "保存 Git 配置", exact: true }).click();
    await page.waitForFunction(
      () =>
        globalThis.__gitWorkspace.management.snapshot().configuration.userName ===
        "检测期间保留草稿",
    );
    await page.evaluate(() => globalThis.__gitWorkspace.management.releaseDetection());
    await page.getByRole("button", { name: "检测本机账号", exact: true }).waitFor();
    await page.evaluate(() => globalThis.__gitWorkspace.management.failDetection());
    await page.getByRole("button", { name: "检测本机账号", exact: true }).click();
    await page
      .getByRole("alert")
      .getByText("自动检测失败。可手动填写路径或账号。", { exact: true })
      .waitFor();
    assert.equal(
      await page.getByRole("textbox", { name: "提交者姓名", exact: true }).inputValue(),
      "检测期间保留草稿",
    );
    assert.equal((await snapshot()).accounts.length, 1);
  });
  await runGitAccountAuthorizationCases({ t, page, base, fill, snapshot });
  await runGitSystemAccountCases({ t, page, base, snapshot });
  await t.test("SSH 密钥列表眼睛可用键盘展开与收起，缺少公钥给出说明", async () => {
    await page.goto(base + "?management");
    const list = page.getByTestId("git-ssh-key-list");
    await list.waitFor();
    assert.equal(await list.getByTestId("git-ssh-key").count(), 2);
    const eye = list.getByRole("button", { name: "查看 id_ed25519 的密钥信息", exact: true });
    await eye.focus();
    await eye.press("Enter");
    const details = list.getByTestId("git-ssh-key-details");
    await details.waitFor();
    assert.ok((await details.textContent()).includes("SHA256:fixture-public-fingerprint"));
    assert.ok(
      (await details.getByRole("textbox", { name: "公钥", exact: true }).inputValue()).startsWith(
        "ssh-ed25519 ",
      ),
    );
    await list.screenshot({ path: "artifacts/git-management-layout/ssh-key-details.png" });
    await list
      .getByRole("button", { name: "收起 id_ed25519 的密钥信息", exact: true })
      .press("Space");
    await details.waitFor({ state: "detached" });
    await list.getByRole("button", { name: "查看 id_missing 的密钥信息", exact: true }).click();
    assert.ok(
      (await list.getByTestId("git-ssh-key-details").textContent()).includes(
        "未找到有效的对应 .pub 公钥",
      ),
    );
    await page.screenshot({
      path: "artifacts/git-management-layout/ssh-key-list.png",
      fullPage: true,
    });
  });
  await t.test("390px 明暗主题与英文设置无横向溢出", async () => {
    await mkdir("artifacts/git-management", { recursive: true });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const query of ["?management", "?management&dark&english"]) {
      await page.goto(base + query);
      const section = page.getByTestId("git-management-section");
      await section.waitFor();
      await page.getByTestId("git-ssh-key-list").waitFor();
      await page
        .getByRole("button", {
          name: query.includes("english")
            ? "View key information for id_ed25519"
            : "查看 id_ed25519 的密钥信息",
          exact: true,
        })
        .click();
      await page
        .getByRole("button", {
          name: query.includes("english") ? "Add account" : "添加账号",
          exact: true,
        })
        .click();
      assert.ok(await section.evaluate((node) => node.scrollWidth <= node.clientWidth + 1));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({
        path: `artifacts/git-management/${query.includes("dark") ? "dark-english" : "light"}.png`,
        fullPage: true,
      });
    }
  });
  assert.deepEqual(errors, []);
});
