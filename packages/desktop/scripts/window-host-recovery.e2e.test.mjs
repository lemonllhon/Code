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
  "real Electron Host exit restores the window service port and persisted draft, without replaying input",
  { timeout: 60_000 },
  async (t) => {
    const cache = join(desktopRoot, "node_modules/.cache");
    await mkdir(cache, { recursive: true });
    const directory = await mkdtemp(join(cache, "host-recovery-e2e-"));
    let electronApp;
    t.after(async () => {
      await electronApp?.close();
      await cleanupFixtureDirectory(directory);
    });
    const source = (path) => JSON.stringify(resolve(desktopRoot, path).replaceAll("\\", "/"));
    const compile = async (contents, output, extra = {}) => {
      const result = await build({
        stdin: { contents, resolveDir: desktopRoot },
        outfile: join(directory, output),
        bundle: true,
        platform: "node",
        format: "esm",
        external: ["electron"],
        metafile: true,
        logLevel: "silent",
        ...extra,
      });
      for (const artifact of Object.values(result.metafile.outputs))
        assert.ok(
          !artifact.imports.some((entry) => entry.external && entry.path.startsWith("@lcode/")),
          "Electron fixtures must bundle workspace TypeScript imports",
        );
    };
    await compile(
      `
    import {ChannelServer,MessagePortProtocol,Event} from '@lcode/rpc';
    import {ISettingService} from '@lcode/services';
    import {HostMessageTypes,HostResponseTypes} from '@lcode/shared';
    import {wrapElectronPort} from ${source("src/host/electronPort.ts")};
    process.parentPort.on('message',({data,ports})=>{
      if(data.type==='fixture-crash')process.exit(5);
      if(data.type===HostMessageTypes.Dispose)process.exit(0);
      if(data.type!==HostMessageTypes.InitLocal && data.type!==HostMessageTypes.AttachServicePort)return;
      const server=new ChannelServer(new MessagePortProtocol(wrapElectronPort(ports[0])),'fixture');
      server.registerChannel(ISettingService.channelName,{call:async(_ctx,method)=>{
        if(method!=='get')throw Error('recovery must not replay writes');return {pid:process.pid};
      },listen:()=>Event.None});
      if(data.databaseStartupId)process.parentPort.postMessage({type:HostResponseTypes.DatabaseStartupState,state:{
        schemaVersion:1,startupId:data.databaseStartupId,attemptId:data.databaseStartupId,sequence:1,
        startedAt:1,updatedAt:1,phase:'ready',disk:[]
      }});
    });
  `,
      "host.mjs",
    );
    await compile(
      `
    import {createMessagePortServiceConnection} from '@lcode/client';
    import {InternalChannels} from '@lcode/shared';
    import {DatabaseStartupAdmission} from ${source("src/renderer/src/databaseStartupAdmission.ts")};
    const {ipcRenderer}=require('electron');
    const admission=new DatabaseStartupAdmission();let connected=false;
    document.body.innerHTML='<p id="status">preparing</p><textarea id="draft"></textarea>';
    const draft=document.getElementById('draft');draft.value=localStorage.getItem('fixture-draft')||'retained draft';
    localStorage.setItem('fixture-draft',draft.value);
    const enter=async()=>{
      const port=admission.takeReadyPort();if(!port||connected)return;connected=true;
      const connection=createMessagePortServiceConnection(port);
      const result=await connection.services.settingService.get();
      window.fixture={pid:result.pid,draft:draft.value,startupId:admission.state.startupId};
      document.getElementById('status').textContent='ready';
    };
    ipcRenderer.on(InternalChannels.DatabaseStartupState,(_event,state)=>{admission.acceptState(state);void enter();});
    ipcRenderer.on(InternalChannels.ServicePort,(event,payload)=>{admission.acceptPort(payload,event.ports[0]);void enter();});
  `,
      "renderer.cjs",
      { platform: "browser", format: "iife", packages: undefined, external: ["electron"] },
    );
    await writeFile(
      join(directory, "index.html"),
      '<!doctype html><meta charset="utf-8"><script defer src="./renderer.cjs"></script>',
    );
    await compile(
      `
    import {app,BrowserWindow,MessageChannelMain,utilityProcess} from 'electron';
    import {randomUUID} from 'node:crypto';
    import {join} from 'node:path';
    import {createWindow} from ${source("src/main/desktopWindowLifecycle.ts")};
    import {bindDatabaseStartupRelay} from ${source("src/main/databaseStartupRelay.ts")};
    import {HostResponseTypes,InternalChannels} from '@lcode/shared';
    async function main(){const directory=${JSON.stringify(directory)};
    app.setPath('userData',join(directory,'profile'));app.disableHardwareAcceleration();await app.whenReady();
    const map=new Map(),children=[],forceQuitRef={current:false};
    const win=createWindow({iconPath:'',preloadPath:'',logger:{info(){},warn(){}},forceQuitRef,
      windowHostProcessMap:map,deviceMid:'fixture',agentSpawnFallbackCwd:directory,runtimeProcessEnvFallbackPatch:{},
      spawnHostProcess:(win,label,init,retry)=>{
        const child=utilityProcess.fork(join(directory,'host.mjs'),[],{serviceName:'Host recovery fixture',stdio:'pipe'});
        children.push(child);const relay=bindDatabaseStartupRelay(win,child,randomUUID(),retry);
        child.on('message',message=>{if(message.type===HostResponseTypes.DatabaseStartupState)relay.receive(message.state)});
        child.once('exit',()=>{if(map.get(win.webContents.id)===child)map.delete(win.webContents.id)});
        const {port1,port2}=new MessageChannelMain();
        child.postMessage({...init,databaseStartupId:relay.startupId},[port2]);
        win.webContents.postMessage(InternalChannels.ServicePort,{databaseStartupId:relay.startupId},[port1]);return child;
      },
      disposeHostProcess:child=>{child.fixtureDisposing=true;child.postMessage({type:'dispose'})},
      syncAutoUpdaterStateToWindow(){},syncReadyUpdateToWindow(){},syncPostUpdateReleaseNotesToWindow(){},
      disposeRemoteWorkspaceSessionsForWindow(){},reattachRemoteWorkspaceSessionsForWindow(){}
    });
    globalThis.recoveryFixture={win,children,map,forceQuitRef};
    }void main().catch(error=>{process.stderr.write(String(error.stack));app.exit(1)});
  `,
      "main.mjs",
      {
        plugins: [
          {
            name: "isolated-window-adapters",
            setup(builder) {
              const stubs = {
                "./desktopWindowChrome.js": `import {BrowserWindow} from 'electron';export const createBrowserWindow=()=>{const win=new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false}});win.show=()=>{};win.focus=()=>{};void win.loadFile(${JSON.stringify(join(directory, "index.html"))});return win;};`,
                "./desktopHostProcess.js": `export const isHostProcessDisposing=child=>child.fixtureDisposing;`,
                "./databaseStartupTelemetry.js": `export const reportDatabaseStartupState=()=>{};`,
                "./armsBrowserPerfLoadNudge.js": `export const scheduleArmsBrowserPerfLoadNudge=()=>{};`,
                "./resourceManagerWindow.js": `export const registerMainApplicationWindow=()=>{};export const unregisterMainApplicationWindow=()=>{};`,
                "./desktopWindowSize.js": `export const attachDesktopWindowSizePersistence=()=>{};`,
                "./unreadBadge.js": `export const parseWindowUnreadCount=()=>0;export const sumWindowUnreadCounts=()=>0;export const syncAppUnreadBadge=()=>{};`,
              };
              builder.onResolve({ filter: /.*/ }, (args) =>
                args.path in stubs
                  ? { path: args.path, namespace: "fixture", pluginData: stubs[args.path] }
                  : undefined,
              );
              builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
                contents: args.pluginData,
                loader: "js",
              }));
            },
          },
        ],
      },
    );
    await writeFile(
      join(directory, "bootstrap.cjs"),
      `
    const {app}=require('electron');
    const fail=error=>{process.stderr.write(String(error?.stack||error));app.exit(1)};
    process.on('uncaughtException',fail);process.on('unhandledRejection',fail);
    import('./main.mjs').catch(fail);
  `,
    );
    electronApp = await _electron.launch({
      executablePath: require("electron"),
      args: [join(directory, "bootstrap.cjs")],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    });
    let diagnostics = "";
    electronApp.process().stderr.on("data", (chunk) => {
      diagnostics += chunk;
    });
    electronApp.process().stdout.on("data", (chunk) => {
      diagnostics += chunk;
    });
    let page;
    try {
      page = await electronApp.firstWindow({ timeout: 8_000 });
    } catch (error) {
      t.diagnostic(diagnostics.slice(-6000));
      throw error;
    }
    await page.waitForFunction(() => window.fixture?.pid);
    const before = await page.evaluate(() => window.fixture);
    await electronApp.evaluate(() =>
      globalThis.recoveryFixture.children.at(-1).postMessage({ type: "fixture-crash" }),
    );
    await page.waitForFunction(
      (pid) => window.fixture?.pid && window.fixture.pid !== pid,
      before.pid,
    );
    const after = await page.evaluate(() => window.fixture);
    assert.notEqual(after.startupId, before.startupId);
    assert.equal(after.draft, before.draft);
    assert.equal(await electronApp.evaluate(() => globalThis.recoveryFixture.children.length), 2);
    await electronApp.evaluate(async () => {
      const f = globalThis.recoveryFixture;
      f.forceQuitRef.current = true;
      const closed = new Promise((resolve) => f.win.once("closed", resolve));
      f.win.close();
      await closed;
    });
    assert.equal(await electronApp.evaluate(() => globalThis.recoveryFixture.map.size), 0);
    t.diagnostic(
      `Electron ${await electronApp.evaluate(() => process.versions.electron)}; Utility exit 5 restored one window Host`,
    );
  },
);
