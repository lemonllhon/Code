import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { tsImport } from "tsx/esm/api";
import { build } from "tsup";
import { _electron } from "playwright-core";

const desktop = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);

test(
  "production preload bundles run in the real Electron sandbox",
  { timeout: 90_000 },
  async (t) => {
    const artifacts = resolve(desktop, "../../.artifacts/desktop-memory");
    await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(join(artifacts, "preload-sandbox-"));
    const previousCwd = process.cwd();
    const previousEnv = process.env.NODE_ENV;
    let config;
    try {
      process.chdir(desktop);
      process.env.NODE_ENV = "production";
      const loaded = await tsImport("../tsup.config.ts", import.meta.url);
      config = loaded.default.find((entry) => entry.name === "preload");
      assert.ok(config);
      await build({
        ...config,
        config: false,
        outDir: root,
        onSuccess: undefined,
        metafile: true,
        silent: true,
        esbuildOptions(options, context) {
          config.esbuildOptions?.(options, context);
          options.absWorkingDir = desktop;
        },
      });
    } finally {
      process.chdir(previousCwd);
      if (previousEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousEnv;
    }
    await t.test("all preload outputs are self-contained except Electron", async () => {
      const names = await readdir(root, { recursive: true });
      const metadata = names.filter((name) => name.includes("metafile") && name.endsWith(".json"));
      assert.ok(metadata.length > 0, "tsup must emit its actual dependency graph");
      for (const name of metadata) {
        const graph = JSON.parse(await readFile(join(root, name), "utf8"));
        const imports = Object.values(graph.outputs).flatMap((output) => output.imports);
        assert.deepEqual(
          imports.filter((item) => item.path !== "electron"),
          [],
        );
      }
    });
    if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      await t.test(
        "native sandbox startup",
        { skip: "Run with xvfb-run -a on headless Linux" },
        () => {},
      );
      return;
    }
    const { InternalChannels } = await tsImport("../../shared/src/channels.ts", import.meta.url);
    const html = join(root, "fixture.html");
    await writeFile(
      html,
      "<!doctype html><title>Preload sandbox fixture</title><main>Fixture</main>",
    );
    const main = join(root, "fixture.cjs");
    await writeFile(
      main,
      `const {app,BrowserWindow,ipcMain}=require('electron');
    app.setPath('userData',${JSON.stringify(join(root, "chromium"))});
    globalThis.preloadErrors=[];globalThis.controls=[];
    app.on('web-contents-created',(_event,contents)=>contents.on('preload-error',(_event,path,error)=>globalThis.preloadErrors.push({path,message:error.message})));
    ipcMain.on(${JSON.stringify(InternalChannels.DatabaseStartupControl)},(_event,payload)=>globalThis.controls.push(payload));
    app.whenReady().then(()=>{const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:${JSON.stringify(join(root, "preload/index.cjs"))}}});win.loadFile(${JSON.stringify(html)});});
    app.on('window-all-closed',()=>app.quit());`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const electron = await _electron.launch({
      executablePath: require("electron"),
      args: [main],
      env,
    });
    t.after(() => electron.close());
    const page = await electron.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await t.test("main bridge and startup validation survive sandbox loading", async () => {
      assert.deepEqual(await electron.evaluate(() => globalThis.preloadErrors), []);
      assert.deepEqual(
        await page.evaluate(() => ({
          print: typeof window.lcode?.printPageToPdf,
          require: typeof window.require,
        })),
        { print: "function", require: "undefined" },
      );
      await page.evaluate(
        ({ state, control, port }) => {
          window.receivedStartup = [];
          window.receivedPort = false;
          window.addEventListener("message", (event) => {
            if (event.data?.type === state) window.receivedStartup.push(event.data.state);
            if (event.data?.type === port) {
              event.ports[0].onmessage = (reply) => {
                window.receivedPort = reply.data === "main-ready";
              };
              event.ports[0].postMessage("renderer-ready");
            }
          });
          window.postMessage({ type: control, control: { action: "invalid" } }, "*");
          window.postMessage({ type: control, control: { action: "snapshot" } }, "*");
        },
        {
          state: InternalChannels.DatabaseStartupState,
          control: InternalChannels.DatabaseStartupControl,
          port: InternalChannels.ServicePort,
        },
      );
      const state = {
        schemaVersion: 1,
        startupId: "fixture-startup",
        attemptId: "fixture-attempt",
        sequence: 1,
        startedAt: 1,
        updatedAt: 2,
        phase: "ready",
        disk: [],
      };
      await electron.evaluate(
        ({ BrowserWindow, MessageChannelMain }, { state, channels }) => {
          const contents = BrowserWindow.getAllWindows()[0].webContents;
          contents.send(channels.DatabaseStartupState, { ...state, phase: "invalid" });
          contents.send(channels.DatabaseStartupState, state);
          const { port1, port2 } = new MessageChannelMain();
          port1.once("message", (event) => {
            globalThis.portReply = event.data;
            port1.postMessage("main-ready");
            port1.close();
          });
          port1.start();
          contents.postMessage(channels.ServicePort, { databaseStartupId: state.startupId }, [
            port2,
          ]);
        },
        { state, channels: InternalChannels },
      );
      await page.waitForFunction(() => window.receivedStartup.length === 1 && window.receivedPort);
      assert.deepEqual(await page.evaluate(() => window.receivedStartup), [state]);
      assert.deepEqual(await electron.evaluate(() => globalThis.controls), [
        { action: "snapshot" },
      ]);
      assert.equal(await electron.evaluate(() => globalThis.portReply), "renderer-ready");
    });
    await t.test("auxiliary preloads also load with sandbox and isolation enabled", async () => {
      for (const entry of Object.keys(config.entry).filter((entry) => entry !== "preload/index")) {
        await electron.evaluate(
          async ({ BrowserWindow }, { preload, html }) => {
            const win = new BrowserWindow({
              show: false,
              webPreferences: {
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
                preload,
              },
            });
            await win.loadFile(html);
            win.destroy();
          },
          { preload: join(root, `${entry}.cjs`), html },
        );
      }
      assert.deepEqual(await electron.evaluate(() => globalThis.preloadErrors), []);
    });
  },
);
