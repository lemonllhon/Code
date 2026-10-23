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
const source = (name) =>
  JSON.stringify(resolve(desktopRoot, "../ui/src", name).replaceAll("\\", "/"));

for (const remote of [false, true])
  test(
    `${remote ? "remote identity" : "local path"} query UI recovers hard invalidation and fences unmounted flights`,
    { timeout: 30_000 },
    async (t) => {
      await mkdir(join(desktopRoot, "node_modules/.cache"), { recursive: true });
      const directory = await mkdtemp(
        join(desktopRoot, "node_modules/.cache/query-cache-lifecycle-"),
      );
      let server, browser;
      t.after(async () => {
        await browser?.close();
        await new Promise((done) => (server ? server.close(done) : done()));
        await cleanupFixtureDirectory(directory);
      });
      await build({
        stdin: {
          resolveDir: desktopRoot,
          loader: "tsx",
          contents: `
    import React,{useState}from'react';import{createRoot}from'react-dom/client';
    import{useWorkspaceTaskLists}from ${source("hooks/useWorkspaceTaskLists.ts")};
    import{useTaskQueryCacheStore as cache}from ${source("store/taskQueryCacheStore.ts")};
    import{useRemoteWorkspaceSessionStore as remoteStore}from ${source("store/remoteWorkspaceSessionStore.ts")};
    const remote=${JSON.stringify(remote)};
    window.scopeKey=remote?'fixture-identity':'/fixture';
    window.pending=[];window.endpoints=[];window.cache=cache;
    window.services={lcodeTaskService:{marker:'local',onDynamicWorkspaceEvent:()=>()=>({dispose(){}})},lcodeAgentService:{}};
    if(remote)remoteStore.getState().registerSession({sessionId:'fixture-remote',workspacePath:'/fixture',workspaceIdentity:'fixture-identity',services:{...window.services,lcodeTaskService:{...window.services.lcodeTaskService,marker:'remote'}}});
    window.index={items:[],sourceRevisionByScopeKey:{}};
    window.finish=(index,title)=>window.pending[index]({taskIndexItems:[{taskId:'task',traceId:'synthetic',workspacePath:'/fixture',...(remote?{workspaceIdentity:'fixture-identity'}:{}),title,mode:'auto',createdAt:1,updatedAt:1,status:'completed'}],pinnedIds:new Set(),archivedIds:new Set(),deletedIds:new Set(),unreadAtByTaskId:new Map(),terminalStatusByTaskId:new Map(),titleOverrideByTaskId:new Map(),cronAutomationIdByTaskId:new Map()});
    const params={workspaceTabs:[{id:'fixture-tab',kind:'workspace',workspacePath:'/fixture',...(remote?{workspaceIdentity:'fixture-identity',remoteSessionId:'fixture-remote'}:{})}],activeWorkspacePath:'/fixture',...(remote?{activeWorkspaceIdentity:'fixture-identity'}:{}),sortBy:'updated',visibleLimitByWorkspaceKey:{},defaultVisibleLimit:20};
    function Probe(){const result=useWorkspaceTaskLists(params);window.result=result;return <output id="result">{JSON.stringify(result.groups)}</output>}
    function App(){const[open,setOpen]=useState(true);window.toggle=setOpen;return open?<Probe/>:<div id="closed"/>;}
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
            name: "indexed-query-ports",
            setup(builder) {
              const stubs = {
                "@/hooks/useWorkspaceServices.js":
                  "export const useBaseWorkspaceServices=()=>window.services;",
                "@/v4/useWorkspaceSessionsIndexItems.js":
                  "export const useWorkspaceSessionsIndexItems=()=>window.index;export const buildWorkspaceSessionsIndexSourceKey=scope=>scope.workspaceIdentity||scope.workspacePath;",
                "@/lib/taskListMembershipSets.js":
                  "export const fetchTaskListMembershipSetsForEndpointsCached=params=>{window.endpoints.push(params.endpoints[0].service.marker);return new Promise(done=>window.pending.push(done));};",
                "@/logger.js":
                  "export const logMemoryDiagnostics=()=>{};export const logger={debug(){},info(){},warn(){},error(...args){throw Error(args.map(String).join(' '));}};",
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
      await new Promise((done) => server.listen(0, "127.0.0.1", done));
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(3000);

      await page.goto(`http://127.0.0.1:${server.address().port}`);
      try {
        await page.waitForFunction(() => window.pending.length === 1);
      } catch (error) {
        t.diagnostic(
          JSON.stringify({
            errors,
            state: await page.evaluate(() => ({
              pending: window.pending?.length,
              active: window.cache?.getState().activeQueries,
              result: window.result?.groups,
              body: document.body.textContent.slice(0, 500),
            })),
          }),
        );
        throw error;
      }
      await page.evaluate(() => window.cache.getState().invalidateWorkspaceKeys([window.scopeKey]));
      await page.evaluate(() => window.finish(0, "stale"));
      await page.waitForFunction(() => window.pending.length === 2);
      assert.ok(!(await page.locator("#result").textContent()).includes("stale"));
      await page.evaluate(() => window.finish(1, "fresh"));
      await page.waitForFunction(() =>
        document.querySelector("#result").textContent.includes("fresh"),
      );
      assert.equal(await page.evaluate(() => window.pending.length), 2);
      await page.evaluate(() => window.cache.getState().invalidateWorkspaceKeys([window.scopeKey]));
      await page.waitForFunction(() => window.pending.length === 3);
      await page.evaluate(() => window.toggle(false));
      await page.locator("#closed").waitFor({ state: "attached" });
      await page.evaluate(() => window.finish(2, "unmounted"));
      await page.evaluate(() => window.toggle(true));
      await page.waitForFunction(() => window.pending.length === 4);
      await page.evaluate(() => window.finish(3, "reopened"));
      await page.waitForFunction(() =>
        document.querySelector("#result").textContent.includes("reopened"),
      );
      assert.ok(!(await page.locator("#result").textContent()).includes("unmounted"));
      assert.deepEqual(
        await page.evaluate(() => window.endpoints),
        Array(4).fill(remote ? "remote" : "local"),
      );
      assert.deepEqual(errors, []);
    },
  );
