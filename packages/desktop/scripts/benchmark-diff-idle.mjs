// 隔离显示层 A/B，测量旧/新 Provider 的增量，不能代表完整桌面包收益。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { arch, cpus, release, totalmem } from "node:os";
import { createHash } from "node:crypto";
import { _electron } from "playwright-core";
import { cleanupFixtureDirectory, desktopRoot } from "./main-runtime-test-fixture.mjs";

const baseline = process.argv[2];
if (!baseline || !/^[0-9a-f]{7,40}$/.test(baseline))
  throw Error("Pass the baseline commit SHA as the first argument");
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsup"))("esbuild");
const root = resolve(desktopRoot, "../..");
const provider = resolve(root, "packages/ui/src/root/DiffsWorkerPoolProvider.tsx");
const { stdout: before } = await promisify(execFile)(
  "git",
  ["show", `${baseline}:packages/ui/src/root/DiffsWorkerPoolProvider.tsx`],
  { cwd: root, windowsHide: true },
);
const after = await readFile(provider, "utf8");
await mkdir(join(desktopRoot, "node_modules/.cache"), { recursive: true });
const directory = await mkdtemp(join(desktopRoot, "node_modules/.cache/diff-idle-ab-"));
let server, electron;
const samples = [];
try {
  await build({
    entryPoints: [resolve(root, "packages/ui/src/workers/diffs.worker.ts")],
    outfile: join(directory, "worker.js"),
    bundle: true,
    platform: "browser",
    format: "esm",
    treeShaking: false,
    ignoreAnnotations: true,
    logLevel: "silent",
  });
  for (const [variant, contents] of [
    ["before", before],
    ["after", after],
  ]) {
    await build({
      stdin: {
        resolveDir: root,
        contents: `
      import React from'react';import{createRoot}from'react-dom/client';import{useWorkerPool}from'@pierre/diffs/react';
      import{DiffsWorkerPoolProvider}from ${JSON.stringify(provider.replaceAll("\\", "/"))};
      window.counts={created:0,terminated:0};const Native=window.Worker;
      window.Worker=class extends Native{constructor(url,options){super('/worker.js',options);window.counts.created++;}terminate(){window.counts.terminated++;super.terminate();}};
      function Probe(){const pool=useWorkerPool();window.readPool=()=>({ready:!pool||pool.isInitialized(),stats:pool?.getStats()});return React.createElement('input',{defaultValue:'unsent'});}
      createRoot(document.getElementById('root')).render(React.createElement(DiffsWorkerPoolProvider,null,React.createElement(Probe)));
    `,
      },
      outfile: join(directory, variant + ".js"),
      bundle: true,
      platform: "browser",
      format: "iife",
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "silent",
      plugins: [
        {
          name: "baseline-display-port",
          setup(builder) {
            builder.onLoad({ filter: /DiffsWorkerPoolProvider\.tsx$/ }, () => ({
              contents: contents.replace(
                'new URL("../workers/diffs.worker.ts", import.meta.url)',
                'new URL("/worker.js",window.location.href)',
              ),
              loader: "tsx",
              resolveDir: resolve(provider, ".."),
            }));
            const stubs = {
              "@/store/StoreProvider.js":
                "export const useLCodeStore=selector=>selector({codePreviewSettings:{lightTheme:'github-light',darkTheme:'github-dark'}});",
              "@/store/index.js":
                "export const DEFAULT_CODE_PREVIEW_SETTINGS={lightTheme:'github-light',darkTheme:'github-dark'};",
              "@/logger.js":
                "export const logMemoryDiagnostics=()=>{};export const logger={debug(){},info(){},warn(){},error(){}};",
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
          },
        },
      ],
    });
  }
  const files = Object.fromEntries(
    await Promise.all(
      ["before.js", "after.js", "worker.js"].map(async (name) => [
        "/" + name,
        await readFile(join(directory, name)),
      ]),
    ),
  );
  server = createServer((request, response) => {
    response.setHeader(
      "Content-Type",
      request.url.endsWith(".js") ? "text/javascript" : "text/html",
    );
    response.end(
      files[request.url] ??
        `<!doctype html><div id="root"></div><script src="/${request.url.includes("before") ? "before" : "after"}.js"></script>`,
    );
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  for (let trial = 0; trial < 5; trial++)
    for (const variant of trial % 2 ? ["after", "before"] : ["before", "after"]) {
      await writeFile(
        join(directory, "main.cjs"),
        `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, `profile-${trial}-${variant}`))});app.disableHardwareAcceleration();app.whenReady().then(()=>{const win=new BrowserWindow({show:false});win.loadURL('http://127.0.0.1:${server.address().port}/${variant}');});app.on('window-all-closed',()=>app.quit());`,
      );
      electron = await _electron.launch({
        args: [join(directory, "main.cjs")],
        env: { ...process.env, NODE_TEST_CONTEXT: undefined, ELECTRON_RUN_AS_NODE: undefined },
      });
      const page = await electron.firstWindow();
      await page.waitForFunction(() => window.readPool?.().ready === true);
      const counts = await page.evaluate(() => window.counts);
      assert.ok(variant === "before" ? counts.created > 0 : counts.created === 0);
      const observations = [];
      for (let i = 0; i < 3; i++) {
        // 初始化由 ready 事实确认；此处仅为独立测量采样窗口。
        await new Promise((done) => setTimeout(done, 1000));
        observations.push(
          await electron.evaluate(({ app }) =>
            app.getAppMetrics().map(({ type, memory }) => ({ type, memory })),
          ),
        );
      }
      samples.push({ trial, variant, counts, observations });
      await electron.close();
      electron = undefined;
    }
  const artifacts = resolve(root, ".artifacts/desktop-memory");
  await mkdir(artifacts, { recursive: true });
  await writeFile(
    join(artifacts, "diff-idle-comparison.json"),
    JSON.stringify(
      {
        baseline,
        platform: process.platform,
        node: process.version,
        hardware: {
          arch: arch(),
          osRelease: release(),
          cpuModel: cpus()[0]?.model,
          logicalCpus: cpus().length,
          memoryMiB: Math.round(totalmem() / 1048576),
        },
        providerSha256: {
          before: createHash("sha256").update(before).digest("hex"),
          after: createHash("sha256").update(after).digest("hex"),
        },
        scope:
          "isolated production-mode display fixture, same current dependencies and shell; only Provider implementation changes; GPU disabled; not full packaged-app baseline",
        samples,
      },
      null,
      2,
    ),
  );
} finally {
  await electron?.close();
  await new Promise((done) => (server ? server.close(done) : done()));
  await cleanupFixtureDirectory(directory);
}
