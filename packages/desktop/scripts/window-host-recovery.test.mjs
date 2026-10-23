import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadSource } from "./main-runtime-test-fixture.mjs";

const electron = `
  import {EventEmitter} from 'node:events';
  export const ipcMain=new EventEmitter();
  export const app={}, Menu={}, BrowserWindow={};
  export class MessageChannelMain {port1={};port2={}}
  export const win=new EventEmitter();
  export const wc=Object.assign(new EventEmitter(),{id:7,isDestroyed:()=>false,reload(){wc.emit('reload')},postMessage(){}});
  Object.assign(win,{id:1,webContents:wc,isDestroyed:()=>false,show(){},focus(){}});
`;

test("a stale Host cannot unregister the replacement broadcast owner", async (t) => {
  const { BroadcastHub } = await loadSource(t, "src/main/broadcastHub.ts");
  const hub = new BroadcastHub();
  const old = new EventEmitter();
  const current = new EventEmitter();
  hub.register(7, old);
  hub.register(7, current);
  hub.unregister(7, old);
  assert.equal(hub.collectMemoryDiagnostics().processes, 1);
  hub.unregister(7, current);
  assert.equal(hub.collectMemoryDiagnostics().processes, 0);
});

test("stale Host resource cleanup retains replacement Agent registrations", async (t) => {
  const runtime = await loadSource(t, "src/main/resourceManagerWindow.ts");
  const old = new EventEmitter(),
    current = new EventEmitter();
  runtime.registerHostProcess("fixture", old);
  runtime.registerHostProcess("fixture", current);
  runtime.registerHostAgentProcess("fixture", {
    pid: 42,
    provider: "lcode",
    workspacePath: "/fixture",
    command: "fixture",
    args: [],
    startedAt: 1,
  });
  runtime.unregisterHostProcess("fixture", old);
  assert.deepEqual(runtime.listRegisteredHostAgentProcessIds(), [42]);
  runtime.unregisterHostProcess("fixture", current);
  assert.deepEqual(runtime.listRegisteredHostAgentProcessIds(), []);
});

test("window exit wiring rebuilds exactly one Host, preserves reload reattach and bounds crashes", async (t) => {
  const { createWindow, testElectron } = await loadSource(t, "src/main/desktopWindowLifecycle.ts", {
    electron,
    "./desktopWindowChrome.js": `import {win} from 'electron'; export const createBrowserWindow=()=>win;`,
    "./desktopHostProcess.js": `export const isHostProcessDisposing=child=>child.disposing;`,
    "./databaseStartupRelay.js": `export const getDatabaseStartupPortPayload=()=>({databaseStartupId:'fixture'});`,
    "./armsBrowserPerfLoadNudge.js": `export const scheduleArmsBrowserPerfLoadNudge=()=>{};`,
    "./resourceManagerWindow.js": `export const registerMainApplicationWindow=()=>{};export const unregisterMainApplicationWindow=()=>{};`,
    "./desktopWindowSize.js": `export const attachDesktopWindowSizePersistence=()=>{};`,
    "./unreadBadge.js": `export const parseWindowUnreadCount=()=>0;export const sumWindowUnreadCounts=()=>0;export const syncAppUnreadBadge=()=>{};`,
  });
  const map = new Map();
  const children = [];
  const callbacks = [];
  const forceQuitRef = { current: false };
  const win = createWindow({
    iconPath: "",
    preloadPath: "",
    logger: { info() {}, warn() {} },
    forceQuitRef,
    windowHostProcessMap: map,
    spawnHostProcess: (_win, _label, init, retry) => {
      assert.equal(init.type, "init-local");
      assert.deepEqual(init.agentWarmupTargets, [], "明确空名单在 spawn 和重建 Host 时均不能丢失");
      const child = Object.assign(new EventEmitter(), {
        pid: children.length + 1,
        postMessage() {},
      });
      child.once("exit", () => {
        if (map.get(7) === child) map.delete(7);
      });
      callbacks.push(retry);
      children.push(child);
      return child;
    },
    disposeHostProcess: (child) => {
      child.disposing = true;
      child.emit("exit", 0);
    },
    syncAutoUpdaterStateToWindow() {},
    syncReadyUpdateToWindow() {},
    syncPostUpdateReleaseNotesToWindow() {},
    disposeRemoteWorkspaceSessionsForWindow() {},
    reattachRemoteWorkspaceSessionsForWindow() {},
    agentSpawnFallbackCwd: "fixture",
    agentWarmupTargets: [],
    deviceMid: "fixture",
    runtimeProcessEnvFallbackPatch: {},
  });
  const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
  let reloads = 0;
  testElectron.wc.on("reload", () => {
    reloads++;
    testElectron.wc.emit("dom-ready");
  });
  testElectron.wc.emit("dom-ready");
  await nextTurn();
  assert.equal(children.length, 1);
  testElectron.wc.emit("dom-ready");
  await nextTurn();
  assert.equal(children.length, 1, "a live Host survives ordinary renderer reload");
  for (let i = 0; i < 4; i++) {
    children.at(-1).emit("exit", 5);
    await nextTurn();
  }
  assert.equal(reloads, 3);
  assert.equal(children.length, 4);
  callbacks.at(-1)();
  await nextTurn();
  assert.equal(children.length, 5, "explicit retry must have a real restart path");
  children[0].emit("exit", 5);
  await nextTurn();
  assert.equal(map.get(7), children[4]);
  forceQuitRef.current = true;
  win.emit("closed");
  await nextTurn();
  assert.equal(children.length, 5);
});

test("exited database startup retry is fenced by window and attempt", async (t) => {
  const { bindDatabaseStartupRelay, testElectron } = await loadSource(
    t,
    "src/main/databaseStartupRelay.ts",
    {
      electron,
      "./databaseStartupTelemetry.js": `export const reportDatabaseStartupState=()=>{};`,
    },
  );
  const { InternalChannels } = await import("@lcode/shared");
  testElectron.wc.send = () => {};
  const child = Object.assign(new EventEmitter(), { postMessage() {} });
  let retries = 0;
  const relay = bindDatabaseStartupRelay(testElectron.win, child, "startup", () => retries++);
  relay.receive({
    schemaVersion: 1,
    startupId: "startup",
    attemptId: "attempt",
    sequence: 1,
    startedAt: 1,
    updatedAt: 1,
    phase: "ready",
    disk: [],
  });
  child.emit("exit", 5);
  const control = (sender, attemptId) =>
    testElectron.ipcMain.emit(
      InternalChannels.DatabaseStartupControl,
      { sender },
      { action: "retry", attemptId },
    );
  control({}, "attempt");
  control(testElectron.wc, "stale");
  assert.equal(retries, 0);
  control(testElectron.wc, "attempt");
  assert.equal(retries, 1);
  testElectron.win.emit("closed");
});
