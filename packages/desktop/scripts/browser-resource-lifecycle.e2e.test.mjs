import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { _electron } from "playwright-core";
import { cleanupFixtureDirectory, desktopRoot } from "./main-runtime-test-fixture.mjs";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsup"))("esbuild");
test(
  "real BrowserGuestManager preserves hidden form state and closes owned guest resources",
  { timeout: 60_000 },
  async (t) => {
    await mkdir(join(desktopRoot, "node_modules/.cache"), { recursive: true });
    const directory = await mkdtemp(join(desktopRoot, "node_modules/.cache/browser-resources-"));
    let electron;
    t.after(async () => {
      await electron?.close();
      await cleanupFixtureDirectory(directory);
    });
    await writeFile(
      join(directory, "index.html"),
      '<!doctype html><webview style="width:600px;height:400px" src="data:text/html,<input id=field><title>fixture</title>"></webview>',
    );
    const source = JSON.stringify(
      resolve(desktopRoot, "src/main/browserView/browserGuestManager.ts").replaceAll("\\", "/"),
    );
    await build({
      stdin: {
        resolveDir: desktopRoot,
        contents: `
    import{app,BrowserWindow,webContents}from'electron';import{BrowserGuestManager}from ${source};
    app.setPath('userData',${JSON.stringify(join(directory, "profile"))});
    globalThis.manager=new BrowserGuestManager();
    app.whenReady().then(async()=>{globalThis.fixtureWindow=new BrowserWindow({show:false,webPreferences:{webviewTag:true}});await globalThis.fixtureWindow.loadFile(${JSON.stringify(join(directory, "index.html"))});}).catch(error=>{console.error(error);app.exit(1)});
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
          name: "workspace-public-entries",
          setup(builder) {
            builder.onResolve({ filter: /(?:^|\/)logger\.js$/ }, () => ({
              path: "logger",
              namespace: "log-port",
            }));
            builder.onLoad({ filter: /.*/, namespace: "log-port" }, () => ({
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
    electron = await _electron.launch({
      args: [join(directory, "main.mjs")],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_TEST_CONTEXT: undefined },
    });
    const processOutput = [];
    electron.process().stderr.on("data", (data) => processOutput.push(String(data)));
    const page = await electron.firstWindow().catch((error) => {
      throw new Error(`${error.message}\n${processOutput.join("")}`, { cause: error });
    });
    const guestId = await electron.evaluate(async ({ webContents }) => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const guest = webContents.getAllWebContents().find((item) => item.getType() === "webview");
        if (guest && !guest.isLoading()) return guest.id;
        await new Promise((done) => setTimeout(done, 50));
      }
      throw Error("guest did not load");
    });
    assert.equal(
      await electron.evaluate(
        (_, id) => globalThis.manager.attachGuest("fixture-tab", id).ok,
        guestId,
      ),
      true,
    );
    const write = await electron.evaluate(() =>
      globalThis.manager.execute("fixture-tab", {
        method: "evaluate",
        tabId: "fixture-tab",
        expression:
          "(()=>{document.getElementById('field').value='unsaved';window.resourceMarker=42;return true})()",
      }),
    );
    assert.equal(write.ok, true, JSON.stringify(write));
    await page.locator("webview").evaluate((view) => (view.style.display = "none"));
    assert.equal(
      await electron.evaluate(
        async ({ webContents }, id) =>
          webContents
            .fromId(id)
            .executeJavaScript("document.getElementById('field').value+'|'+window.resourceMarker"),
        guestId,
      ),
      "unsaved|42",
    );
    await page.locator("webview").evaluate((view) => (view.style.display = "block"));
    assert.equal(
      await electron.evaluate(
        ({ webContents }, id) => webContents.fromId(id).isDestroyed(),
        guestId,
      ),
      false,
    );
    await electron.evaluate(() => globalThis.manager.disposeAll());
    await page.locator("webview").evaluate((view) => view.remove());
    await page.waitForFunction(() => !document.querySelector("webview"));
    assert.deepEqual(
      await electron.evaluate(() => globalThis.manager.listGuestWebContentsIds()),
      [],
    );
    // 真 guest 销毁由 native destroyed 确认，不能把 renderer 发出 remove 当作已退出。
    await electron.evaluate(async ({ webContents }, id) => {
      const deadline = Date.now() + 10_000;
      while (webContents.fromId(id) && Date.now() < deadline)
        await new Promise((done) => setTimeout(done, 20));
      if (webContents.fromId(id)) throw Error("guest still live");
    }, guestId);
  },
);
