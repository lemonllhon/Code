import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import { cleanupFixtureDirectory, desktopRoot } from "./main-runtime-test-fixture.mjs";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsup"))("esbuild");

test(
  "cold task header reads only indexed metadata and fences workspace, attachment and service changes",
  { timeout: 30_000 },
  async (t) => {
    const cache = join(desktopRoot, "node_modules/.cache");
    await mkdir(cache, { recursive: true });
    const directory = await mkdtemp(join(cache, "active-task-meta-e2e-"));
    let browser, server;
    t.after(async () => {
      await browser?.close();
      await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
      await cleanupFixtureDirectory(directory);
    });
    const source = resolve(desktopRoot, "../ui/src/hooks/useActiveTaskSnapshotMeta.ts").replaceAll(
      "\\",
      "/",
    );
    await build({
      stdin: {
        resolveDir: desktopRoot,
        contents: `
        import React from 'react';import {createRoot} from 'react-dom/client';
        import {useActiveTaskSnapshotMeta} from ${JSON.stringify(source)};
        const facts=window.facts={reads:0,requests:[],pending:[],renders:[],defer:false,missing:false};
        const meta=(taskId,owner)=>({taskId,traceId:'trace-'+owner,title:'Saved archived title '+owner,
          titleOverridden:true,provider:'glm',model:'fixture-model',workspacePath:'/origin',
          workspaceIdentity:owner,createdAt:1,updatedAt:2,mode:'build',archived:true});
        const service=owner=>({getTaskMeta:params=>{facts.requests.push({owner,...params});
          if(facts.defer)return new Promise((resolve,reject)=>facts.pending.push({resolve,reject,params,owner}));
          return Promise.resolve(facts.missing?null:meta(params.taskId,owner))}});
        const serviceA=service('a'),serviceB=service('b'),replacement=service('replacement');
        const state=window.state={workspacePath:'/origin',identity:'a',remote:'attachment-a',taskId:'archived',
          listMeta:null,rpcReady:true,services:{lcodeTaskService:serviceA}};
        state.services.lcodeSessionService={readSession:async()=>{facts.reads++;throw Error('Session is not active')}};
        const root=createRoot(document.getElementById('root'));
        function Probe(){const result=useActiveTaskSnapshotMeta(state.workspacePath,state.taskId,state.remote,state.identity,state.listMeta);
          facts.renders.push({identity:state.identity,remote:state.remote,meta:result});
          window.observation=result;return React.createElement('output',{id:'meta'},JSON.stringify(result))}
        const render=()=>root.render(React.createElement(Probe));
        window.controls={set:patch=>{Object.assign(state,patch);render()},
          host:(owner,defer=false)=>{facts.defer=defer;state.identity=owner;state.remote='attachment-'+owner;
            state.services={lcodeTaskService:owner==='a'?serviceA:serviceB,lcodeSessionService:state.services.lcodeSessionService};render()},
          replace:()=>{state.services={...state.services,lcodeTaskService:replacement};render()},
          settle:(index,fail=false)=>{const p=facts.pending[index];fail?p.reject(Error('old failure')):p.resolve(meta(p.params.taskId,p.owner))},
          unmount:()=>root.unmount()};render();
      `,
      },
      outfile: join(directory, "fixture.js"),
      bundle: true,
      platform: "browser",
      format: "iife",
      define: { "process.env.NODE_ENV": '"test"' },
      plugins: [
        {
          name: "task-meta-service-ports",
          setup(builder) {
            const stubs = {
              "./useWorkspaceServices.js":
                "export const useWorkspaceServicesResolution=()=>({services:window.state.services,rpcReady:window.state.rpcReady,remoteSessionId:window.state.remote});",
              "@/hooks/useLCodeSessionService.js":
                "export const useLCodeSessionService=()=>window.state.services.lcodeSessionService;",
              "@/lib/lcodeSessionProjection.js":
                "export const lcodeSessionSnapshotToTaskMeta=value=>value.meta;",
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
    });
    const bundle = await readFile(join(directory, "fixture.js"));
    server = createServer((request, response) => {
      response.setHeader(
        "Content-Type",
        request.url === "/fixture.js" ? "text/javascript" : "text/html",
      );
      response.end(
        request.url === "/fixture.js"
          ? bundle
          : '<!doctype html><div id="root"></div><script src="/fixture.js"></script>',
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(
      () => window.observation?.title === "Saved archived title a",
      undefined,
      { timeout: 3000 },
    );
    assert.equal(await page.evaluate(() => window.facts.reads), 0);
    assert.deepEqual(
      await page.evaluate(() => ({
        trace: window.observation.traceId,
        model: window.observation.model,
        custom: window.observation.titleOverridden,
        archived: window.observation.archived,
      })),
      {
        trace: "trace-a",
        model: "fixture-model",
        custom: true,
        archived: true,
      },
    );
    assert.equal(await page.evaluate(() => window.facts.requests.length), 1);

    await page.evaluate(() =>
      window.controls.set({
        taskId: "listed",
        listMeta: { taskId: "listed", title: "list authority" },
      }),
    );
    await page.waitForFunction(() => window.observation === null);
    assert.equal(await page.evaluate(() => window.facts.requests.length), 1);

    await page.evaluate(() => {
      window.facts.defer = true;
      window.controls.set({ taskId: "shared", listMeta: null });
    });
    await page.waitForFunction(() => window.facts.pending.length === 1);
    assert.equal(await page.evaluate(() => window.observation), null);
    await page.evaluate(() => window.controls.host("b"));
    await page.waitForFunction(() => window.observation?.traceId === "trace-b");
    await page.evaluate(() => window.controls.settle(0));
    await page.waitForFunction(() => window.observation?.traceId === "trace-b");
    assert.equal(await page.evaluate(() => window.facts.requests.at(-1).workspaceIdentity), "b");

    // 相同服务引用/相同 taskId 也必须按 identity 与 attachment 隔离，不能依赖换 service 才清旧值。
    await page.evaluate(() => {
      window.facts.defer = true;
      window.controls.set({ identity: "identity-c" });
    });
    await page.waitForFunction(() => window.facts.pending.length === 2);
    assert.equal(await page.evaluate(() => window.observation), null);
    assert.equal(
      await page.evaluate(() =>
        window.facts.renders
          .filter((row) => row.identity === "identity-c")
          .every((row) => row.meta === null),
      ),
      true,
    );
    await page.evaluate(() => window.controls.set({ remote: "attachment-c" }));
    await page.waitForFunction(() => window.facts.pending.length === 3);
    assert.equal(await page.evaluate(() => window.observation), null);
    await page.evaluate(() => {
      window.facts.defer = false;
      window.controls.settle(2);
      window.controls.settle(1, true);
    });
    await page.waitForFunction(() => window.observation?.traceId === "trace-b");

    await page.evaluate(() => window.controls.replace());
    await page.waitForFunction(() => window.observation?.traceId === "trace-replacement");
    const requests = await page.evaluate(() => window.facts.requests.length);
    await page.evaluate(() => window.controls.set({ rpcReady: false }));
    await page.waitForFunction(() => window.observation === null);
    assert.equal(await page.evaluate(() => window.facts.requests.length), requests);
    await page.evaluate(() => window.controls.set({ rpcReady: true }));
    await page.waitForFunction(() => window.observation?.traceId === "trace-replacement");
    assert.equal(await page.evaluate(() => window.facts.requests.length), requests + 1);

    await page.evaluate(() => {
      window.facts.defer = true;
      window.controls.set({ workspacePath: "/another-local", identity: undefined, remote: null });
    });
    await page.waitForFunction(() => window.facts.pending.length === 4);
    assert.equal(await page.evaluate(() => window.observation), null);
    assert.equal(
      await page.evaluate(() => window.facts.requests.at(-1).workspacePath),
      "/another-local",
    );
    await page.evaluate(() => {
      window.facts.defer = false;
      window.controls.settle(3);
    });
    await page.waitForFunction(() => window.observation?.traceId === "trace-replacement");

    await page.evaluate(() => {
      window.facts.defer = true;
      window.controls.set({ taskId: "failed-meta-read" });
    });
    await page.waitForFunction(() => window.facts.pending.length === 5);
    await page.evaluate(() => {
      window.facts.defer = false;
      window.controls.settle(4, true);
    });
    assert.equal(await page.evaluate(() => window.observation), null);

    await page.evaluate(() => {
      window.facts.missing = true;
      window.controls.set({ taskId: "missing" });
    });
    await page.waitForFunction(
      () => window.facts.requests.at(-1)?.taskId === "missing" && window.observation === null,
    );
    assert.equal(await page.evaluate(() => window.facts.reads), 0);
    await page.evaluate(() => window.controls.set({ taskId: null }));
    await page.waitForFunction(() => window.observation === null);
    await page.evaluate(() => window.controls.unmount());
  },
);
