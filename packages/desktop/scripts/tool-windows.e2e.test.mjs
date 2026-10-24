import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { _electron } from "playwright-core";
import { startWorkflowProgressBrowser } from "../../web/test/workflow-execution-progress-browser.mjs";
import { cleanupFixtureDirectory, desktopRoot } from "./main-runtime-test-fixture.mjs";
import {
  assertSameProjectGitIsolation,
  assertReviewDock,
} from "./tool-window-git-ownership-cases.mjs";
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsup"))("esbuild");
async function clickAndClose(page, locator) {
  await Promise.all([
    page.waitForEvent("close"),
    locator.click().catch((error) => {
      if (!page.isClosed()) throw error;
    }),
  ]);
}

test(
  "native tool windows preserve React/PTY state, dock by drag and close through the owner",
  { timeout: 180000 },
  async (t) => {
    const { port } = await startWorkflowProgressBrowser(t);
    const cache = join(desktopRoot, "node_modules/.cache");
    await mkdir(cache, { recursive: true });
    const directory = await mkdtemp(join(cache, "tool-windows-"));
    let electron;
    t.after(async () => {
      if (electron) {
        await electron
          .evaluate(({ BrowserWindow }) => {
            globalThis.manager?.disposeAll();
            for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
          })
          .catch(() => {});
        await electron.close();
      }
      await cleanupFixtureDirectory(directory);
    });
    const source = (file) =>
      JSON.stringify(resolve(desktopRoot, `src/main/${file}`).replaceAll("\\", "/"));
    const chrome = JSON.stringify(
      resolve(desktopRoot, "src/main/desktopToolWindows.ts").replaceAll("\\", "/"),
    );
    await writeFile(
      join(directory, "preload.cjs"),
      `const {contextBridge,ipcRenderer}=require('electron');const listen=(channel,callback)=>{const listener=(_,payload)=>callback(payload);ipcRenderer.on(channel,listener);return()=>ipcRenderer.removeListener(channel,listener)};contextBridge.exposeInMainWorld('lcode',{
 closeToolWindow:id=>ipcRenderer.send('lcode:close-tool-window',id),
 browserViewAttachGuest:payload=>ipcRenderer.invoke('fixture:attach',payload),browserViewDetachGuest:payload=>ipcRenderer.invoke('fixture:detach',payload),browserViewCloseTab:payload=>ipcRenderer.invoke('fixture:close',payload),
 onBrowserViewGuestAttached:callback=>listen('lcode:browser-view-guest-attached',callback),
 onBrowserViewScreenshotSurfacePrepare:callback=>listen('lcode:browser-view-screenshot-surface-prepare',callback),onBrowserViewScreenshotSurfaceRelease:callback=>listen('lcode:browser-view-screenshot-surface-release',callback),browserViewScreenshotSurfaceReady:payload=>ipcRenderer.send('fixture:surface-ready',payload)
});`,
    );
    await build({
      stdin: {
        resolveDir: desktopRoot,
        contents: `
    import {app,BrowserWindow,ipcMain,session} from 'electron';
    import {BrowserGuestManager} from ${source("browserView/browserGuestManager.ts")};
    import {BrowserTabRecoveryStore} from ${source("browserView/browserTabRecoveryStore.ts")};
    import {installBrowserRestoreBootstrapProtocol} from ${source("browserView/browserRestoreBootstrapProtocol.ts")};
    import {configureDesktopToolWindows} from ${chrome};
    app.setPath('userData',${JSON.stringify(join(directory, "profile"))});
    app.disableHardwareAcceleration();
    globalThis.manager = new BrowserGuestManager(undefined,20000,undefined,undefined,undefined,undefined,undefined,undefined,{recoveryStore:new BrowserTabRecoveryStore(${JSON.stringify(join(directory, "browser-recovery.json"))})});
    ipcMain.handle('fixture:attach',(_event,payload)=>globalThis.manager.attachGuest(payload.key,payload.webContentsId,{...payload,windowId:globalThis.owner.id}));
    ipcMain.handle('fixture:detach',(_event,payload)=>globalThis.manager.detachGuestBeforeReplacement(payload.key,payload.webContentsId,globalThis.owner.id,payload.preservePageState));
    ipcMain.handle('fixture:close',(_event,payload)=>globalThis.manager.closeTabFromRenderer({...payload,windowId:globalThis.owner.id}));
    ipcMain.on('fixture:surface-ready',(_event,payload)=>globalThis.surfaceResolve?.(payload));
    app.on('before-quit',()=>globalThis.manager.disposeAll());
    app.whenReady().then(async()=>{
      installBrowserRestoreBootstrapProtocol(session.fromPartition('persist:lcode-embedded-browser').protocol);
      const win=new BrowserWindow({show:false,width:1200,height:800,webPreferences:{preload:${JSON.stringify(join(directory, "preload.cjs"))},contextIsolation:true,nodeIntegration:false,webviewTag:true}});const forward=(host)=>host.on('did-attach-webview',(_,guest)=>win.webContents.send('lcode:browser-view-guest-attached',{webContentsId:guest.id}));forward(win.webContents);configureDesktopToolWindows(win,child=>forward(child.webContents));globalThis.owner=win;await win.loadURL('http://127.0.0.1:${port}/test/fixtures/tool-windows.html'); });
    app.on('window-all-closed',()=>app.quit());
  `,
      },
      outfile: join(directory, "main.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      external: ["electron"],
      logLevel: "silent",
      plugins: [
        {
          name: "workspace-entries",
          setup(builder) {
            builder.onResolve({ filter: /(?:^|\/)logger\.js$/ }, () => ({
              path: "logger",
              namespace: "fixture-log",
            }));
            builder.onLoad({ filter: /.*/, namespace: "fixture-log" }, () => ({
              contents: "export const logger={info(){},warn(){},debug(){},error(){}};",
              loader: "js",
            }));
            builder.onResolve({ filter: /^@lcode\/(shared|model-option-map)$/ }, (args) => ({
              path: resolve(
                desktopRoot,
                args.path === "@lcode/shared"
                  ? "../shared/src/index.ts"
                  : "../model-option-map/src/index.ts",
              ),
            }));
          },
        },
      ],
    });
    await writeFile(
      join(directory, "bootstrap.cjs"),
      `const {app}=require('electron');process.on('uncaughtException',e=>{console.error(e);app.exit(1)});process.on('unhandledRejection',e=>{console.error(e);app.exit(1)});import(${JSON.stringify(new URL("file:///" + join(directory, "main.mjs").replaceAll("\\", "/")).href)}).catch(e=>{console.error(e);app.exit(1)});`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    electron = await _electron.launch({
      executablePath: require("electron"),
      args: [join(directory, "bootstrap.cjs")],
      env,
    });
    const page = await electron.firstWindow();
    page.setDefaultTimeout(15000);
    const errors = [];
    const watch = (page) =>
      page.on("pageerror", (error) => {
        errors.push(error.message);
        t.diagnostic(error.stack);
      });
    watch(page);
    await page.getByRole("textbox", { name: "Commit draft" }).fill("retained draft");
    assert.equal(await page.getByTestId("side-pane-tool-git").count(), 1);
    assert.equal(await page.getByTestId("side-pane-tool-terminal").count(), 0);
    let popupEvent = electron.waitForEvent("window");
    await page.getByRole("button", { name: "Detach active" }).click();
    let popup = await popupEvent;
    watch(popup);
    await popup.getByRole("textbox", { name: "Commit draft" }).waitFor();
    assert.equal(
      await popup.getByRole("textbox", { name: "Commit draft" }).inputValue(),
      "retained draft",
    );
    await popup.getByRole("button", { name: "Options" }).click();
    await popup.getByRole("menuitem", { name: "Inside this window" }).waitFor();
    assert.equal(await page.getByRole("menuitem", { name: "Inside this window" }).count(), 0);
    await popup.keyboard.press("Escape");
    const wasDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
    await page.getByRole("button", { name: "Theme", exact: true }).click();
    await popup.waitForFunction(
      (wasDark) => document.documentElement.classList.contains("dark") !== wasDark,
      wasDark,
    );
    await mkdir(".artifacts/side-pane-windows", { recursive: true });
    await popup.screenshot({ path: ".artifacts/side-pane-windows/window.png" });
    await clickAndClose(popup, popup.getByRole("button", { name: "放回右侧", exact: true }));
    await page.getByRole("textbox", { name: "Commit draft" }).waitFor();
    assert.equal(
      await page.getByRole("textbox", { name: "Commit draft" }).inputValue(),
      "retained draft",
    );
    assert.deepEqual(
      await page.evaluate(() => [
        window.toolWindowFixture.facts.mounts,
        window.toolWindowFixture.facts.unmounts,
      ]),
      [1, 0],
    );
    popupEvent = electron.waitForEvent("window");
    await page.getByTestId("side-pane-tool-git").dragTo(page.locator("main > section").first());
    popup = await popupEvent;
    watch(popup);
    await popup.getByRole("textbox", { name: "Commit draft" }).waitFor();
    const transfer = await popup
      .getByRole("button", { name: "拖到原窗口右侧以放回" })
      .evaluate((node) => {
        const dataTransfer = new DataTransfer();
        node.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
        return [...dataTransfer.types].map((type) => [type, dataTransfer.getData(type)]);
      });
    assert.equal(transfer[0]?.[0], "application/x-lcode-tool-window");
    const closed = popup.waitForEvent("close");
    await page.getByTestId("dock").evaluate((node, entries) => {
      const dataTransfer = new DataTransfer();
      for (const [type, data] of entries) dataTransfer.setData(type, data);
      node.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    }, transfer);
    await closed;
    assert.equal(
      await page.getByRole("textbox", { name: "Commit draft" }).inputValue(),
      "retained draft",
    );
    await page.getByRole("button", { name: "Add terminal" }).click();
    await page.waitForFunction(() => window.toolWindowFixture.facts.creates === 1);
    await page.locator(".xterm-helper-textarea").pressSequentially("before");
    popupEvent = electron.waitForEvent("window");
    await page.getByRole("button", { name: "Detach active" }).click();
    popup = await popupEvent;
    watch(popup);
    await popup.locator(".xterm-helper-textarea").pressSequentially("after");
    await page.waitForFunction(() => window.toolWindowFixture.facts.writes.includes("beforeafter"));
    assert.equal(await page.evaluate(() => window.toolWindowFixture.facts.creates), 1);
    await clickAndClose(popup, popup.getByRole("button", { name: "关闭标签" }));
    await page.waitForFunction(() => window.toolWindowFixture.facts.disposes === 1);
    assert.equal(await page.getByTestId("side-pane-tool-terminal").count(), 0);
    // The native × must request the same owner close, including its async guards.
    await page.getByTestId("side-pane-tool-git").click();
    popupEvent = electron.waitForEvent("window");
    await page.getByRole("button", { name: "Detach active" }).click();
    popup = await popupEvent;
    watch(popup);
    await popup.getByRole("textbox", { name: "Commit draft" }).waitFor();
    await electron.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((win) => win !== globalThis.owner)
        .close(),
    );
    await page.waitForFunction(() => window.toolWindowFixture.facts.unmounts === 1);
    assert.equal(
      await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      1,
    );
    assert.deepEqual(errors, []);
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/tool-window-owners.html`);
    await page.getByRole("button", { name: "Open file", exact: true }).click();
    await page.getByText("Project A retained content", { exact: true }).waitFor();
    popupEvent = electron.waitForEvent("window");
    await page.getByRole("button", { name: "在独立窗口中打开", exact: true }).click();
    popup = await popupEvent;
    watch(popup);
    await popup.getByTestId("tool-window-owner").waitFor();
    assert.equal(await popup.getByTestId("tool-window-owner").innerText(), "Project A · chat-a");
    await page.evaluate(() => window.toolOwnerFixture.switch("/fixture/repo", "chat-a2"));
    await page.getByTestId("active-owner").getByText("Project A · chat-a2").waitFor();
    await popup.getByText("Project A retained content", { exact: true }).waitFor();
    await page.evaluate(() => window.toolOwnerFixture.switch("/fixture/project-b", "chat-b"));
    await page.getByTestId("active-owner").getByText("Project B · chat-b").waitFor();
    await page.getByRole("button", { name: "Open file", exact: true }).click();
    await page.getByText("Project B retained content", { exact: true }).waitFor();
    assert.match(await popup.title(), /Project A.*chat-a/);
    await popup.getByText("Project A retained content", { exact: true }).waitFor();
    await popup.screenshot({ path: ".artifacts/side-pane-windows/owner-window.png" });
    const ownerTransfer = await popup
      .getByRole("button", { name: "拖到原窗口右侧以放回" })
      .evaluate((node) => {
        const dataTransfer = new DataTransfer();
        node.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
        return [...dataTransfer.types].map((type) => [type, dataTransfer.getData(type)]);
      });
    const dropTarget = page.getByTestId("side-pane-window-dock-target");
    await dropTarget.getByText("Project A · chat-a", { exact: true }).waitFor();
    const ownerClosed = popup.waitForEvent("close");
    await dropTarget.evaluate((node, entries) => {
      const dataTransfer = new DataTransfer();
      for (const [type, data] of entries) dataTransfer.setData(type, data);
      node.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    }, ownerTransfer);
    await ownerClosed;
    await dropTarget.waitFor({ state: "detached" });
    await page
      .getByTestId("active-owner")
      .getByText("Project A · chat-a", { exact: true })
      .waitFor();
    await page.getByText("Project A retained content", { exact: true }).waitFor();
    // 同项目不同会话分别打开 Git；关闭原窗口不能改写新会话的激活标签和折叠态。
    await page.getByRole("button", { name: "Open Git", exact: true }).click();
    await page.getByTestId("git-view-review").click();
    await page.getByTestId("git-commit-message-input").fill("Project A draft");
    popupEvent = electron.waitForEvent("window");
    await page.getByRole("button", { name: "在独立窗口中打开", exact: true }).click();
    popup = await popupEvent;
    watch(popup);
    await popup.getByTestId("tool-window-owner").waitFor();
    await assertSameProjectGitIsolation(page, popup, clickAndClose);
    // 跨项目关闭同样只修改原工作区。
    popupEvent = electron.waitForEvent("window");
    await page.getByRole("button", { name: "在独立窗口中打开", exact: true }).click();
    popup = await popupEvent;
    watch(popup);
    await popup.getByTestId("tool-window-owner").waitFor();
    await page.evaluate(() => window.toolOwnerFixture.switch("/fixture/project-b", "chat-b"));
    await page.getByRole("button", { name: "Open Git", exact: true }).click();
    await page.getByTestId("side-pane-tool-git").waitFor();
    assert.equal(
      await popup.getByTestId("git-commit-message-input").inputValue(),
      "Project A2 draft",
    );
    await clickAndClose(popup, popup.getByRole("button", { name: "关闭标签", exact: true }));
    assert.deepEqual(
      await page.evaluate(() => [
        window.toolOwnerFixture.hasGit("/fixture/repo"),
        window.toolOwnerFixture.hasGit("/fixture/project-b"),
        window.toolOwnerFixture.state().workspace,
      ]),
      [false, true, "/fixture/project-b"],
    );
    await page.evaluate(() => window.toolOwnerFixture.switch("/fixture/repo", "chat-a"));
    await page
      .getByTestId("active-owner")
      .getByText("Project A · chat-a", { exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Open browser", exact: true }).click();
    await page.waitForFunction(() => {
      try {
        return [...document.querySelectorAll("webview")].some((view) =>
          view.getURL().includes("tool-window-page.html"),
        );
      } catch {
        return false;
      }
    });
    popupEvent = electron.waitForEvent("window");
    await page.getByRole("button", { name: "在独立窗口中打开", exact: true }).click();
    popup = await popupEvent;
    watch(popup);
    await popup.waitForFunction(() => {
      try {
        return document.querySelector("webview").getURL().includes("tool-window-page.html");
      } catch {
        return false;
      }
    });
    await popup
      .locator("webview")
      .evaluate((view) =>
        view.executeJavaScript(
          "window.retainedMarker='keep';document.querySelector('input').value='keep'",
        ),
      );
    await page.evaluate(() => window.toolOwnerFixture.switch("/fixture/project-b", "chat-b"));
    await page.getByTestId("active-owner").getByText("Project B · chat-b").waitFor();
    assert.equal(
      await popup
        .locator("webview")
        .evaluate((view) =>
          view.executeJavaScript("window.retainedMarker+'|'+document.querySelector('input').value"),
        ),
      "keep|keep",
    );
    const ready = await electron.evaluate(async () => {
      const id = globalThis.manager.listGuestWebContentsIds()[0];
      const scope = globalThis.manager.getTabOwnerByWebContentsId(id);
      const request = {
        ...scope,
        requestId: "native-background-shot",
        webContentsId: id,
        viewport: { width: 640, height: 400 },
      };
      const received = new Promise((resolve) => {
        globalThis.surfaceResolve = resolve;
      });
      globalThis.owner.webContents.send("lcode:browser-view-screenshot-surface-prepare", request);
      const result = await received;
      globalThis.owner.webContents.send("lcode:browser-view-screenshot-surface-release", request);
      return result;
    });
    assert.equal(ready.workspaceKey, "/fixture/repo");
    assert.equal(ready.sessionId, "chat-a");
    assert.deepEqual(ready.viewport, { width: 640, height: 400 });
    assert.equal(
      await page.evaluate(() => window.toolOwnerFixture.state().workspace),
      "/fixture/project-b",
    );
    await popup.screenshot({ path: ".artifacts/side-pane-windows/browser-window.png" });
    await clickAndClose(popup, popup.getByRole("button", { name: "关闭标签", exact: true }));
    assert.deepEqual(
      await electron.evaluate(() => globalThis.manager.listGuestWebContentsIds()),
      [],
    );
    await assertReviewDock(page, electron, watch);
    await page.evaluate(() => window.toolOwnerFixture.switch("/fixture/repo", "chat-delete"));
    await page.getByTestId("active-owner").getByText("Project A · chat-delete").waitFor();
    await page.evaluate(() => window.toolOwnerFixture.openEphemeralFile());
    await page.getByText("Will be deleted", { exact: true }).waitFor();
    const deletingTabId = await page.evaluate(() => window.toolOwnerFixture.currentTab());
    popupEvent = electron.waitForEvent("window");
    await page.getByRole("button", { name: "在独立窗口中打开", exact: true }).click();
    popup = await popupEvent;
    watch(popup);
    await popup.getByTestId("tool-window-owner").waitFor();
    await page.evaluate(() => window.toolOwnerFixture.switch("/fixture/project-b", "chat-b"));
    await page.getByTestId("active-owner").getByText("Project B · chat-b").waitFor();
    const deletedWindowClosed = popup.waitForEvent("close");
    await page.evaluate(() => window.toolOwnerFixture.deleteTask("/fixture/repo", "chat-delete"));
    await deletedWindowClosed;
    assert.equal(
      await page.evaluate(
        (id) => window.toolOwnerFixture.hasTab("/fixture/repo", id),
        deletingTabId,
      ),
      false,
    );
    assert.equal(
      await page.evaluate(() => window.toolOwnerFixture.state().workspace),
      "/fixture/project-b",
    );
    assert.deepEqual(errors, []);
  },
);
