import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { _electron } from "playwright-core";
import { cleanupFixtureDirectory, desktopRoot } from "./main-runtime-test-fixture.mjs";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsup"))("esbuild");
const ui = resolve(desktopRoot, "../ui/src");
const source = (name) => JSON.stringify(resolve(ui, name).replaceAll("\\", "/"));
const soakMs = Number(process.env.LCODE_MEMORY_SOAK_MS ?? 0);
if (!Number.isFinite(soakMs) || soakMs < 0 || soakMs > 8 * 60 * 60_000)
  throw new Error("LCODE_MEMORY_SOAK_MS must be between 0 and 8 hours");

test(
  "production Renderer leases one real Worker, preserves Root drafts and releases repeated previews",
  { timeout: 120_000 + soakMs },
  async (t) => {
    await mkdir(join(desktopRoot, "node_modules/.cache"), { recursive: true });
    const directory = await mkdtemp(join(desktopRoot, "node_modules/.cache/renderer-memory-"));
    let electron, server;
    t.after(async () => {
      await electron?.close();
      await new Promise((done) => (server ? server.close(done) : done()));
      await cleanupFixtureDirectory(directory);
    });
    await build({
      entryPoints: [resolve(ui, "workers/diffs.worker.ts")],
      outfile: join(directory, "worker.js"),
      bundle: true,
      format: "esm",
      platform: "browser",
      // 与 Desktop/Web 的 Vite worker 子构建一致：依赖漏声明 worker 的注册副作用。
      treeShaking: false,
      ignoreAnnotations: true,
      logLevel: "silent",
    });
    await build({
      stdin: {
        resolveDir: desktopRoot,
        loader: "tsx",
        contents: `
    import React,{useState} from 'react';import{createRoot}from'react-dom/client';
    import{DiffsWorkerPoolProvider}from ${source("root/DiffsWorkerPoolProvider.tsx")};
    import{CodeViewer}from ${source("components/ui/code-viewer.tsx")};
    import{DiffViewer}from ${source("components/ui/diff-viewer.tsx")};
    import{uiMemoryDiagnosticsRegistry as registry}from ${source("lib/memoryDiagnostics.ts")};
    import{highlightCode}from ${source("lib/shikiHighlighter.ts")};
    import{useWorkspaceCacheReclamation}from ${source("hooks/useWorkspaceCacheReclamation.ts")};
    import{useLCodeSessionStore as sessionStore}from ${source("store/lcodeSessionStore.ts")};
    import{createDefaultWorkspaceState}from ${source("store/lcodeSessionStoreTypes.ts")};
    const seeded=()=>({...createDefaultWorkspaceState('glm'),configOptions:[],configOptionsStatus:'ready',taskListCache:[]});
    sessionStore.setState({workspaces:{local:seeded(),remote:{...seeded(),draftSessionId:'protected-draft'}}});
    window.sessionStore=sessionStore;
    window.highlight=(code,lang='typescript',theme='github-light')=>new Promise(done=>{const cached=highlightCode(code,lang,theme,done);if(cached)done(cached);});
    window.facts={created:0,terminated:0,warnings:[],workerErrors:[],messages:0};const Native=window.Worker;
    window.Worker=class extends Native{constructor(url,opts){super('/worker.js',opts);window.facts.created++;this.addEventListener('error',e=>window.facts.workerErrors.push(e.message));this.addEventListener('message',()=>window.facts.messages++);}terminate(){window.facts.terminated++;super.terminate();}};
    window.settings={lightTheme:'github-light',darkTheme:'github-dark'};
    window.counters=()=>registry.collect();
    function App(){const[count,setCount]=useState(0);const[version,setVersion]=useState(0);const[open,setOpen]=useState(true);
      useWorkspaceCacheReclamation(open?[{workspacePath:'/same',workspaceIdentity:'local'},{workspacePath:'/same',workspaceIdentity:'remote'}]:[]);
      window.controls={count:setCount,closeWorkspaces:()=>setOpen(false),theme:()=>{window.settings={...window.settings,lightTheme:'min-light'};setVersion(version+1);}};
      return <DiffsWorkerPoolProvider><input id="draft" defaultValue="unsent"/>
      {Array.from({length:count},(_,i)=>i%2===0?<CodeViewer key={i} code={'const fixtureValue = 42;'} language="typescript"/>:
      <DiffViewer key={i} patch={'diff --git a/f.ts b/f.ts\\n--- a/f.ts\\n+++ b/f.ts\\n@@ -1 +1 @@\\n-const value = 1;\\n+const value = 2;\\n'}/>)}</DiffsWorkerPoolProvider>;}
    createRoot(document.getElementById('root')).render(<App/>);
  `,
      },
      outfile: join(directory, "fixture.js"),
      bundle: true,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "silent",
      plugins: [
        {
          name: "display-settings-port",
          setup(builder) {
            const stubs = {
              "@/store/StoreProvider.js":
                "export const useLCodeStore=selector=>selector({codePreviewSettings:window.settings});",
              "@/logger.js":
                "export const logMemoryDiagnostics=()=>{};export const logger={debug(){},info(){},warn(...args){window.facts?.warnings.push(args.map(String));},error(){}};",
            };
            builder.onResolve({ filter: /.*/ }, (args) =>
              args.path in stubs
                ? { path: args.path, namespace: "port", pluginData: stubs[args.path] }
                : undefined,
            );
            builder.onLoad({ filter: /.*/, namespace: "port" }, (args) => ({
              contents: args.pluginData,
              loader: "js",
            }));
            builder.onLoad({ filter: /DiffsWorkerPoolProvider\.tsx$/ }, async (args) => ({
              contents: (await readFile(args.path, "utf8")).replace(
                'new URL("../workers/diffs.worker.ts", import.meta.url)',
                'new URL("/worker.js", window.location.href)',
              ),
              loader: "tsx",
            }));
          },
        },
      ],
    });
    const bundle = await readFile(join(directory, "fixture.js")),
      worker = await readFile(join(directory, "worker.js"));
    assert.ok(worker.length > 10_000, "worker message registration must survive bundling");
    server = createServer((request, response) => {
      response.setHeader(
        "Content-Type",
        request.url.endsWith(".js") ? "text/javascript" : "text/html",
      );
      response.end(
        request.url === "/fixture.js"
          ? bundle
          : request.url === "/worker.js"
            ? worker
            : '<!doctype html><div id="root"></div><script src="/fixture.js"></script>',
      );
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    await writeFile(
      join(directory, "main.cjs"),
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, "profile"))});app.disableHardwareAcceleration();app.commandLine.appendSwitch('enable-precise-memory-info');app.whenReady().then(()=>{const win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});win.loadURL('http://127.0.0.1:${server.address().port}');});app.on('window-all-closed',()=>app.quit());`,
    );
    electron = await _electron.launch({
      args: [join(directory, "main.cjs")],
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, ELECTRON_RUN_AS_NODE: undefined },
    });
    const page = await electron.firstWindow();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForFunction(() => !!window.controls);
    assert.equal(await page.evaluate(() => window.facts.created), 0);
    await page.locator("#draft").fill("keep my draft");
    await page.evaluate(() => {
      window.originalInput = document.getElementById("draft");
      window.controls.count(2);
    });
    await page.waitForFunction(
      () =>
        window.counters()["diffPool.workers"] === 1 &&
        window.counters()["diffPool.consumers"] === 2,
    );
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll("diffs-container")).filter(
          (el) =>
            el.shadowRoot?.textContent.includes("fixtureValue") ||
            el.shadowRoot?.textContent.includes("const value"),
        ).length === 2,
    );
    await page.evaluate(() => window.controls.theme());
    await page.waitForFunction(() => window.facts.created === 1);
    await page.evaluate(() => window.controls.count(1));
    await page.waitForFunction(() => window.counters()["diffPool.consumers"] === 1);
    assert.equal(
      await page.evaluate(() => window.facts.terminated),
      0,
      JSON.stringify(await page.evaluate(() => window.facts)),
    );
    const samples = [];
    const started = Date.now();
    const artifacts = resolve(desktopRoot, "../../.artifacts/desktop-memory");
    await mkdir(artifacts, { recursive: true });
    const artifact = join(artifacts, soakMs ? "renderer-soak.json" : "renderer-lifecycle.json");
    const persist = async (complete) =>
      writeFile(
        artifact,
        JSON.stringify(
          {
            fixture: "production-renderer-display-resources",
            platform: process.platform,
            node: process.version,
            soakMs,
            elapsedMs: Date.now() - started,
            complete,
            samples,
          },
          null,
          2,
        ),
      );
    for (let round = 0; round < 6 || Date.now() - started < soakMs; round++) {
      await page.evaluate(() => window.controls.count(3));
      await page.waitForFunction(
        () =>
          window.counters()["diffPool.consumers"] === 3 &&
          window.counters()["diffPool.workers"] === 1,
      );
      if (!soakMs)
        await page.waitForFunction(
          () =>
            document.querySelectorAll("diffs-container").length === 3 &&
            Array.from(document.querySelectorAll("diffs-container")).every(
              (element) => element.shadowRoot?.textContent,
            ),
        );
      await page.evaluate(() => window.controls.count(0));
      await page.waitForFunction(
        () =>
          window.counters()["diffPool.workers"] === 0 &&
          window.counters()["diffPool.consumers"] === 0 &&
          window.facts.created === window.facts.terminated,
      );
      samples.push({
        ...(await page.evaluate(() => ({
          counters: window.counters(),
          workers: { ...window.facts },
          heapUsedBytes: performance.memory?.usedJSHeapSize,
        }))),
        electronAppMetricsMemory: await electron.evaluate(({ app }) =>
          app
            .getAppMetrics()
            .map(({ pid, creationTime, type, memory }) => ({ pid, creationTime, type, memory })),
        ),
      });
      await persist(false);
      // 测量窗口的采样间隔；不参与任何产品初始化或回收时序。
      if (soakMs) await new Promise((done) => setTimeout(done, 5000));
    }
    assert.equal(await page.locator("#draft").inputValue(), "keep my draft");
    assert.equal(
      await page.evaluate(() => window.originalInput === document.getElementById("draft")),
      true,
    );
    assert.deepEqual(errors, []);
    await page.evaluate(async () => {
      for (let i = 0; i < 140; i++) await window.highlight("const uniqueValue = " + i + ";");
      for (const lang of ["javascript", "json", "css", "html", "python"])
        await window.highlight("value = 1", lang);
      window.controls.closeWorkspaces();
    });
    await page.waitForFunction(
      () => window.sessionStore.getState().workspaces.local.configOptions === null,
    );
    assert.equal(
      await page.evaluate(() => window.sessionStore.getState().workspaces.remote.draftSessionId),
      "protected-draft",
    );
    assert.equal(
      await page.evaluate(
        () => window.sessionStore.getState().workspaces.remote.configOptionsStatus,
      ),
      "ready",
    );
    const highlighted = await page.evaluate(() => window.counters());
    assert.ok(highlighted["shiki.tokensCache"] <= 128);
    assert.ok(highlighted["shiki.highlighters"] <= 4);
    assert.equal(highlighted["shiki.inflight"], 0);
    assert.equal(highlighted["shiki.subscribers"], 0);
    await persist(true);
  },
);
