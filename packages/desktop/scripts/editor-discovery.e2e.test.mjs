import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { _electron } from "playwright-core";
import { desktopRoot, cleanupFixtureDirectory } from "./main-runtime-test-fixture.mjs";
import { editorDiscoveryDefines, editorDiscoveryStubs } from "./editor-discovery-test-fixture.mjs";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsup"))("esbuild");

test(
  "Electron remains interactive while concurrent editor requests await discovery",
  {
    skip: process.platform !== "win32",
    timeout: 60_000,
  },
  async (t) => {
    await mkdir(join(desktopRoot, "node_modules/.cache"), { recursive: true });
    const directory = await mkdtemp(join(desktopRoot, "node_modules/.cache/editor-discovery-e2e-"));
    let electron;
    t.after(async () => {
      await electron?.close();
      await cleanupFixtureDirectory(directory);
    });
    const stubs = editorDiscoveryStubs();
    delete stubs.electron;
    const plugin = {
      name: "isolated-editor-io",
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, ({ path }) => {
          if (stubs[path] !== undefined)
            return { path, namespace: "fixture", pluginData: stubs[path] };
          if (path === "@lcode/shared")
            return { path: resolve(desktopRoot, "../shared/src/index.ts") };
        });
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          contents: args.pluginData,
          loader: "js",
        }));
      },
    };
    const preload = join(directory, "preload.cjs");
    await build({
      stdin: {
        contents: `
      const {contextBridge,ipcRenderer}=require('electron');
      const {PlatformChannels}=require('@lcode/shared');
      contextBridge.exposeInMainWorld('lcode',{getInstalledEditors:()=>ipcRenderer.invoke(PlatformChannels.GetInstalledEditors)});
      contextBridge.exposeInMainWorld('editorAudit',{
        ping:()=>ipcRenderer.invoke('editor-audit:ping'),
        release:()=>ipcRenderer.invoke('editor-audit:release'),
        stats:()=>ipcRenderer.invoke('editor-audit:stats'),
      });
    `,
        resolveDir: desktopRoot,
      },
      outfile: preload,
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["electron"],
      plugins: [plugin],
      logLevel: "silent",
    });
    await writeFile(
      join(directory, "index.html"),
      `
    <button id="load">Load editors</button><button id="ping">Ping main</button><button id="release">Release probe</button>
    <output id="status">idle</output><output id="pong"></output>
    <script>
      document.querySelector('#load').onclick=async()=>{
        document.querySelector('#status').textContent='loading';
        window.results=await Promise.all([window.lcode.getInstalledEditors(),window.lcode.getInstalledEditors()]);
        document.querySelector('#status').textContent='done';
      };
      document.querySelector('#ping').onclick=async()=>{document.querySelector('#pong').textContent=await window.editorAudit.ping();};
      document.querySelector('#release').onclick=()=>window.editorAudit.release();
    </script>
  `,
    );
    const main = join(directory, "main.cjs");
    await build({
      stdin: {
        contents: `
      import {app,BrowserWindow,ipcMain} from 'electron';
      import {PlatformChannels} from '@lcode/shared';
      import {getInstalledEditors} from ${JSON.stringify(resolve(desktopRoot, "src/main/editors.ts"))};
      import {state,releaseCommands} from 'editor-audit-state';
      app.setPath('userData',${JSON.stringify(join(directory, "user-data"))});
      state.holdCommands=true;
      let requests=0;
      const getIcon=app.getFileIcon.bind(app);
      app.getFileIcon=(...args)=>{state.icons.push(args[0]);return getIcon(...args);};
      ipcMain.handle(PlatformChannels.GetInstalledEditors,()=>{requests++;return getInstalledEditors();});
      ipcMain.handle('editor-audit:ping',()=> 'pong');
      ipcMain.handle('editor-audit:release',()=> releaseCommands());
      ipcMain.handle('editor-audit:stats',()=>({requests,pending:state.pending.length,commands:state.commands.length,icons:state.icons.length,syncCalls:state.syncCalls}));
      app.whenReady().then(async()=>{
        const win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,preload:${JSON.stringify(preload)}}});
        await win.loadFile(${JSON.stringify(join(directory, "index.html"))});
      });
      app.on('window-all-closed',()=>app.quit());
    `,
        resolveDir: desktopRoot,
      },
      outfile: main,
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["electron"],
      define: editorDiscoveryDefines(),
      plugins: [plugin],
      logLevel: "silent",
    });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    electron = await _electron.launch({ executablePath: require("electron"), args: [main], env });
    const page = await electron.firstWindow();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Load editors" }).click();
    await page.waitForFunction(async () => {
      const state = await window.editorAudit.stats();
      return state.requests === 2 && state.pending === 3;
    });
    await page.getByRole("button", { name: "Ping main" }).click();
    await page.locator("#pong").filter({ hasText: "pong" }).waitFor();
    assert.equal(await page.locator("#status").textContent(), "loading");
    await page.getByRole("button", { name: "Release probe" }).click();
    await page.waitForFunction(() => document.querySelector("#status").textContent === "done");
    assert.deepEqual(
      await page.evaluate(() => window.results.map((result) => result.map((editor) => editor.id))),
      [["explorer"], ["explorer"]],
    );
    const state = await page.evaluate(() => window.editorAudit.stats());
    assert.equal(state.commands, 3);
    assert.equal(state.icons, 1);
    assert.deepEqual(state.syncCalls, []);
    await page.getByRole("button", { name: "Load editors" }).click();
    await page.waitForFunction(async () => {
      const state = await window.editorAudit.stats();
      return state.requests === 4 && document.querySelector("#status").textContent === "done";
    });
    assert.equal((await page.evaluate(() => window.editorAudit.stats())).commands, 3);
    assert.deepEqual(errors, []);
  },
);
