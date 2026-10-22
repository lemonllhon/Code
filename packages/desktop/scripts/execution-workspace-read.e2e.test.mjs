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
  "cold child execution directory comes from its ready projection with legacy and stale owner fences",
  { timeout: 30_000 },
  async (t) => {
    const cache = join(desktopRoot, "node_modules/.cache");
    await mkdir(cache, { recursive: true });
    const directory = await mkdtemp(join(cache, "execution-workspace-e2e-"));
    let browser, server;
    t.after(async () => {
      await browser?.close();
      await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
      await cleanupFixtureDirectory(directory);
    });
    const source = resolve(
      desktopRoot,
      "../ui/src/hooks/useActiveExecutionWorkspace.ts",
    ).replaceAll("\\", "/");
    await build({
      stdin: {
        resolveDir: desktopRoot,
        contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {useActiveExecutionWorkspace} from ${JSON.stringify(source)};
    const execution={workspacePath:'/execution',workspaceIdentity:'execution-a',workspaceKey:'execution-a'};
    const state=window.facts={reads:0,listeners:new Set(),scenario:'child',scope:'origin',remoteSessionId:null,legacy:null,pending:[],released:0};
    state.services={lcodeAgentService:{},lcodeSessionService:{readSession:async()=>{
      state.reads++;if(state.scenario==='child')throw Error('fault.session.inactiveSession');
      if(state.scenario==='pending')return new Promise(resolve=>state.pending.push(resolve));
      return {session:{workspace:{workspacePath:'/legacy',workspaceKey:'/legacy'}}};
    }}};
    state.projection={status:'live',syncing:false,subscriptionId:'fixture',snapshot:{logEpoch:'epoch',executionWorkspace:execution}};
    const root=createRoot(document.getElementById('root'));
    function Probe(){const view=useActiveExecutionWorkspace('/origin',state.scope,state.scenario,state.remoteSessionId);
      window.observation=view;return React.createElement('div',null,
        React.createElement('p',{id:'workspace'},view.workspace?.workspacePath||view.error||'pending'),
        React.createElement('button',{id:'legacy',onClick:()=>change('legacy')},'Legacy'),
        React.createElement('button',{id:'pending',onClick:()=>change('pending')},'Pending'),
        React.createElement('button',{id:'owner',onClick:()=>{state.scope='origin-b';state.remoteSessionId='attachment-b';change('child')}},'Switch owner'));
    }
    function render(){root.render(React.createElement(Probe))}
    function change(scenario){state.scenario=scenario;state.projection={...state.projection,snapshot:{logEpoch:'epoch',...(scenario==='child'?{executionWorkspace:execution}:{})}};render()}
    window.controls={releaseOld:()=>state.pending.splice(0).forEach(resolve=>resolve({session:{workspace:{workspacePath:'/stale',workspaceKey:'/stale'}}})),unmount:()=>root.unmount()};render();
  `,
      },
      outfile: join(directory, "fixture.js"),
      bundle: true,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"test"' },
      plugins: [
        {
          name: "execution-owner-ports",
          setup(builder) {
            const stubs = {
              "./useWorkspaceServices.js": `export const useWorkspaceServicesResolution=()=>({services:window.facts.services,rpcReady:true,remoteSessionId:window.facts.remoteSessionId});`,
              "@/store/worktreeLifecycleStore.js": `export const useWorktreeLifecycleStore=selector=>selector({revisions:{}});`,
              "@/v4/workspaceConnectionRegistry.js": `export const acquireWorkspaceConnection=()=>({activateRemoteService(){},release(){window.facts.released++},layer:{acquire(){return {release(){},store:{getState:()=>window.facts.projection,subscribe(listener){window.facts.listeners.add(listener);return ()=>window.facts.listeners.delete(listener)},retry:async()=>{}}}}}});`,
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
    await page.waitForFunction(() => window.observation && !window.observation.pending);
    assert.equal(await page.locator("#workspace").textContent(), "/execution");
    assert.equal(await page.evaluate(() => window.facts.reads), 0);
    await page.locator("#legacy").click();
    await page.waitForFunction(() => window.observation.workspace?.workspacePath === "/legacy");
    assert.equal(await page.evaluate(() => window.facts.reads), 1);
    await page.locator("#pending").click();
    await page.waitForFunction(() => window.facts.pending.length === 1);
    await page.locator("#owner").click();
    await page.waitForFunction(() => window.observation.workspace?.workspacePath === "/execution");
    await page.evaluate(() => window.controls.releaseOld());
    assert.equal(await page.locator("#workspace").textContent(), "/execution");
    await page.evaluate(() => window.controls.unmount());
    assert.equal(await page.evaluate(() => window.facts.listeners.size), 0);
    assert.equal(await page.evaluate(() => window.facts.released), 4);
  },
);
