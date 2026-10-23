import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { _electron } from "playwright-core";
import { cleanupFixtureDirectory, desktopRoot } from "./main-runtime-test-fixture.mjs";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsup"))("esbuild");
test(
  "settings load on demand without remounting the workspace draft; repeat entry shares one module",
  { timeout: 60_000 },
  async (t) => {
    await mkdir(join(desktopRoot, "node_modules/.cache"), { recursive: true });
    const directory = await mkdtemp(join(desktopRoot, "node_modules/.cache/settings-loading-"));
    let electron, server;
    const gate = Promise.withResolvers();
    t.after(async () => {
      gate.resolve();
      await electron?.close();
      await new Promise((done) => (server ? server.close(done) : done()));
      await cleanupFixtureDirectory(directory);
    });
    const source = JSON.stringify(
      resolve(desktopRoot, "../ui/src/root/LazySettingsPage.tsx").replaceAll("\\", "/"),
    );
    const result = await build({
      stdin: {
        resolveDir: desktopRoot,
        loader: "tsx",
        contents: `
    import React,{useEffect,useState}from'react';import{createRoot}from'react-dom/client';import{LazySettingsPage}from ${source};
    window.mounts=0;function Shell(){const[shown,show]=useState(false);useEffect(()=>{window.mounts++},[]);return React.createElement(React.Fragment,null,React.createElement('input',{id:'draft'}),React.createElement('button',{onClick:()=>show(value=>!value)},'settings'),shown?React.createElement(LazySettingsPage,{captionWorkspacePath:'scoped-workspace'}):null);}
    createRoot(document.getElementById('root')).render(React.createElement(Shell));
  `,
      },
      outdir: directory,
      entryNames: "fixture",
      chunkNames: "[name]-[hash]",
      bundle: true,
      platform: "browser",
      format: "esm",
      splitting: true,
      metafile: true,
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "silent",
      plugins: [
        {
          name: "settings-ports",
          setup(builder) {
            builder.onResolve({ filter: /^@\/SettingsPage\.js$/ }, () => ({
              path: "SettingsPage",
              namespace: "settings-port",
            }));
            builder.onLoad({ filter: /.*/, namespace: "settings-port" }, () => ({
              contents:
                "import React from'react';window.settingsLoads=(window.settingsLoads||0)+1;export const SettingsPage=props=>React.createElement('div',{id:'settings'},props.captionWorkspacePath);",
              loader: "js",
              resolveDir: desktopRoot,
            }));
            builder.onResolve({ filter: /^@\/i18n\/IntlProvider\.js$/ }, () => ({
              path: "intl",
              namespace: "intl-port",
            }));
            builder.onLoad({ filter: /.*/, namespace: "intl-port" }, () => ({
              contents: "export const useLCodeIntl=()=>({intl:{formatMessage:()=> 'loading'}});",
              loader: "js",
            }));
          },
        },
      ],
    });
    const settingsOutput = Object.entries(result.metafile.outputs).find(
      ([, output]) => output.entryPoint === "settings-port:SettingsPage",
    );
    assert.ok(settingsOutput, "actual split settings module must exist");
    const settingsChunk = "/" + basename(settingsOutput[0]);
    const files = new Map(
      await Promise.all(
        (await readdir(directory)).map(async (name) => [
          "/" + name,
          await readFile(join(directory, name)),
        ]),
      ),
    );
    server = createServer(async (request, response) => {
      if (request.url === settingsChunk) await gate.promise;
      response.setHeader(
        "Content-Type",
        request.url.endsWith(".js") ? "text/javascript" : "text/html",
      );
      response.end(
        files.get(request.url) ??
          '<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>',
      );
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    await writeFile(
      join(directory, "main.cjs"),
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.whenReady().then(()=>{const win=new BrowserWindow({show:false});win.loadURL('http://127.0.0.1:${server.address().port}');});app.on('window-all-closed',()=>app.quit());`,
    );
    electron = await _electron.launch({
      args: [join(directory, "main.cjs")],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_TEST_CONTEXT: undefined },
    });
    const page = await electron.firstWindow();
    await page.locator("#draft").fill("unsent instruction");
    assert.equal(await page.evaluate(() => window.settingsLoads ?? 0), 0);
    await page.getByRole("button", { name: "settings" }).click();
    await page.getByRole("status").waitFor();
    await page.locator("#draft").fill("draft remains editable");
    gate.resolve();
    await page.locator("#settings").waitFor();
    assert.equal(await page.locator("#settings").textContent(), "scoped-workspace");
    await page.getByRole("button", { name: "settings" }).click();
    await page.getByRole("button", { name: "settings" }).click();
    await page.locator("#settings").waitFor();
    assert.equal(await page.evaluate(() => window.settingsLoads), 1);
    assert.equal(await page.evaluate(() => window.mounts), 1);
    assert.equal(await page.locator("#draft").inputValue(), "draft remains editable");
  },
);
