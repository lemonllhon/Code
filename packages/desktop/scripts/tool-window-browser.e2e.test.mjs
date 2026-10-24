import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { _electron } from "playwright-core";
import { cleanupFixtureDirectory, desktopRoot } from "./main-runtime-test-fixture.mjs";
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsup"))("esbuild");

test(
  "browser window relocation snapshots history, waits for CDP detach and retains owner/generation checks",
  { timeout: 60000 },
  async (t) => {
    const cache = join(desktopRoot, "node_modules/.cache");
    await mkdir(cache, { recursive: true });
    const directory = await mkdtemp(join(cache, "tool-window-browser-"));
    let electron;
    t.after(async () => {
      if (electron) {
        await electron
          .evaluate(({ BrowserWindow }) => {
            globalThis.manager.disposeAll();
            for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
          })
          .catch(() => {});
        await electron.close();
      }
      await cleanupFixtureDirectory(directory);
    });
    const one = pathToFileURL(join(directory, "one.html")).href;
    const two = pathToFileURL(join(directory, "two.html")).href;
    await writeFile(join(directory, "one.html"), "<title>One</title><input>");
    await writeFile(join(directory, "two.html"), "<title>Two</title><input>");
    await writeFile(
      join(directory, "index.html"),
      `<webview style="width:600px;height:400px" src="about:blank"></webview>`,
    );
    await writeFile(
      join(directory, "preload.cjs"),
      "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('testBridge',{attach:id=>ipcRenderer.invoke('fixture:attach',id),onAttached:callback=>{const listener=(_,id)=>callback(id);ipcRenderer.on('fixture:attached',listener);return ()=>ipcRenderer.removeListener('fixture:attached',listener)}});",
    );
    const source = (file) =>
      JSON.stringify(resolve(desktopRoot, `src/main/browserView/${file}`).replaceAll("\\", "/"));
    await build({
      stdin: {
        resolveDir: desktopRoot,
        contents: `
    import {app,BrowserWindow,ipcMain,session} from 'electron';
    import {BrowserGuestManager} from ${source("browserGuestManager.ts")};
    import {BrowserTabRecoveryStore} from ${source("browserTabRecoveryStore.ts")};
    import {installBrowserRestoreBootstrapProtocol} from ${source("browserRestoreBootstrapProtocol.ts")};
    process.on('uncaughtException',error=>{console.error(error);app.exit(1)});
    process.on('unhandledRejection',error=>{console.error(error);app.exit(1)});
    app.setPath('userData',${JSON.stringify(join(directory, "profile"))});
    app.disableHardwareAcceleration();
    globalThis.recovery = new BrowserTabRecoveryStore(${JSON.stringify(join(directory, "recovery.json"))});
    globalThis.manager = new BrowserGuestManager(undefined,20000,undefined,undefined,undefined,undefined,undefined,undefined,{recoveryStore:globalThis.recovery});
    app.whenReady().then(async()=>{
      installBrowserRestoreBootstrapProtocol(session.defaultSession.protocol);
      ipcMain.handle("fixture:attach",(_,id)=>globalThis.manager.attachGuest("fixture-browser",id,{windowId:globalThis.owner.id,active:true,workspaceKey:"remote:fixture",remoteSessionId:"attachment-fixture",sessionId:"task-fixture"}));
      const win=new BrowserWindow({show:false,webPreferences:{webviewTag:true,preload:${JSON.stringify(join(directory, "preload.cjs"))}}});globalThis.owner=win;
      win.webContents.on("did-attach-webview",(_,guest)=>win.webContents.send("fixture:attached",guest.id));
      win.webContents.setWindowOpenHandler(()=>({action:'allow',overrideBrowserWindowOptions:{show:false,webPreferences:{webviewTag:true}}}));
      await win.loadFile(${JSON.stringify(join(directory, "index.html"))});
    });app.on('before-quit',()=>globalThis.manager.disposeAll());app.on('window-all-closed',()=>app.quit());
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
          name: "workspace-public-entry",
          setup(builder) {
            builder.onResolve({ filter: /(?:^|\/)logger\.js$/ }, () => ({
              path: "logger",
              namespace: "fixture-log",
            }));
            builder.onLoad({ filter: /.*/, namespace: "fixture-log" }, () => ({
              contents: "export const logger={info(){},warn(){},debug(){},error(){}};",
              loader: "js",
            }));
            builder.onResolve({ filter: /^@lcode\/shared$/ }, () => ({
              path: resolve(desktopRoot, "../shared/src/index.ts"),
            }));
            builder.onResolve({ filter: /^@lcode\/model-option-map$/ }, () => ({
              path: resolve(desktopRoot, "../model-option-map/src/index.ts"),
            }));
          },
        },
      ],
    });

    await writeFile(
      join(directory, "bootstrap.cjs"),
      `const {app}=require('electron');process.on('uncaughtException',e=>{console.error(e);app.exit(1)});process.on('unhandledRejection',e=>{console.error(e);app.exit(1)});import(${JSON.stringify(pathToFileURL(join(directory, "main.mjs")).href)}).catch(e=>{console.error(e);app.exit(1)});`,
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

    await page.waitForFunction(() => {
      try {
        return document.querySelector("webview").getWebContentsId() > 0;
      } catch {
        return false;
      }
    });
    let guestId = await page.locator("webview").evaluate((node) => node.getWebContentsId());

    const scope = {
      workspaceKey: "remote:fixture",
      remoteSessionId: "attachment-fixture",
      sessionId: "task-fixture",
    };
    assert.equal(
      await electron.evaluate(
        ({ webContents }, { guestId, scope }) => {
          globalThis.manager.attachGuest("fixture-browser", guestId, {
            windowId: globalThis.owner.id,
            active: true,
            ...scope,
          });
          return webContents.fromId(guestId).isDestroyed();
        },
        { guestId, scope },
      ),
      false,
    );
    await electron.evaluate(
      async ({ webContents }, { guestId, one }) => {
        await webContents.fromId(guestId).loadURL(one);
      },
      { guestId, one },
    );
    await electron.evaluate(
      async ({ webContents }, { guestId, two }) => {
        await webContents.fromId(guestId).loadURL(two);
      },
      { guestId, two },
    );

    assert.equal(
      await electron.evaluate(
        (_, guestId) =>
          globalThis.manager.detachGuestBeforeReplacement(
            "fixture-browser",
            guestId,
            globalThis.owner.id + 100,
            true,
          ),
        guestId,
      ),
      false,
    );
    for (const outward of [true, false]) {
      const previous = guestId;

      assert.equal(
        await electron.evaluate(
          (_, guestId) =>
            globalThis.manager.detachGuestBeforeReplacement(
              "fixture-browser",
              guestId,
              globalThis.owner.id,
              true,
            ),
          guestId,
        ),
        true,
      );
      assert.equal(
        await electron.evaluate(
          ({ webContents }, guestId) => webContents.fromId(guestId).debugger.isAttached(),
          guestId,
        ),
        false,
      );
      const snapshot = await electron.evaluate(() =>
        globalThis.recovery.getPageState("fixture-browser"),
      );

      assert.equal(snapshot.entries[snapshot.activeIndex].url, two);
      assert.ok(snapshot.entries.some((entry) => entry.url === one));
      guestId = await page.evaluate(
        async ({ outward, previous }) => {
          const view = window.relocatedView ?? document.querySelector("webview");
          window.relocatedView = view;
          if (outward) window.toolChild = window.open("about:blank", "fixture");
          if (outward && window.toolChild.document.readyState !== "complete")
            await new Promise((done) =>
              window.toolChild.addEventListener("load", done, { once: true }),
            );
          await new Promise((done, reject) => {
            const attach = (id) => {
              if (id === previous || view.getWebContentsId() !== id) return;
              unsubscribe();
              view.removeEventListener("did-start-loading", loading);
              view.removeAttribute("src");
              window.testBridge.attach(id).then(done, reject);
            };
            const loading = () => attach(view.getWebContentsId());
            const unsubscribe = window.testBridge.onAttached(attach);
            view.addEventListener("did-start-loading", loading);
            view.remove();
            view.setAttribute("src", "lcode-browser-restore://pending");
            (outward ? window.toolChild.document.body : document.body).append(view);
          });
          return view.getWebContentsId();
        },
        { outward, previous },
      );
      assert.notEqual(guestId, previous);

      const result = await electron.evaluate(() => {
        const owner = globalThis.manager.getTabOwner("fixture-browser");
        return globalThis.manager.execute(
          { ...owner, requestId: "verify-relocation" },
          { method: "evaluate", tabId: "fixture-browser", expression: "location.href" },
        );
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(
        await electron.evaluate(
          ({ webContents }, guestId) => webContents.fromId(guestId).getURL(),
          guestId,
        ),
        two,
      );
      const owner = await electron.evaluate(() =>
        globalThis.manager.getTabOwner("fixture-browser"),
      );
      for (const [key, value] of Object.entries(scope)) assert.equal(owner[key], value);
      assert.equal(
        await electron.evaluate(
          (_, previous) =>
            globalThis.manager.detachGuestBeforeReplacement(
              "fixture-browser",
              previous,
              globalThis.owner.id,
              true,
            ),
          previous,
        ),
        false,
      );
    }
    await electron.evaluate(() => globalThis.manager.disposeAll());
  },
);
