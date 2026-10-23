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
const source = (name) =>
  JSON.stringify(resolve(desktopRoot, "../ui/src", name).replaceAll("\\", "/"));

function pdfFixture() {
  const content = "BT /F1 12 Tf 10 100 Td (resource fixture) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => String(offset).padStart(10, "0") + " 00000 n \n")
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return [...Buffer.from(pdf)];
}

for (const mode of ["production", "development"])
  test(
    `${mode}: real media/PDF consumers release resources and xterm detach reuses bounded history`,
    { timeout: 90_000 },
    async (t) => {
      await mkdir(join(desktopRoot, "node_modules/.cache"), { recursive: true });
      const directory = await mkdtemp(join(desktopRoot, "node_modules/.cache/resource-surfaces-"));
      let electron, server;
      t.after(async () => {
        await electron?.close();
        await new Promise((done) => (server ? server.close(done) : done()));
        await cleanupFixtureDirectory(directory);
      });
      await build({
        stdin: {
          resolveDir: desktopRoot,
          loader: "tsx",
          contents: `
      import React,{StrictMode}from'react';import{createRoot}from'react-dom/client';
      import{PreviewPaneMediaContent}from ${source("previewPaneMediaContent.tsx")};
      import{TerminalSession}from ${source("terminal/TerminalSession.tsx")};
      import{PdfViewer}from ${source("components/ui/pdf-viewer.tsx")};
      import{sidePaneTerminalSessionRegistry as registry}from ${source("terminal/sidePaneTerminalSessionRegistry.ts")};
      window.registry=registry;window.mediaEvents=[];window.disposed=[];window.data=new Map();window.created=0;
      for(const method of ['pause','load']){const original=HTMLMediaElement.prototype[method];HTMLMediaElement.prototype[method]=function(...args){window.mediaEvents.push([method,this.getAttribute('data-resource-id'),this.getAttribute('src')]);return original.apply(this,args);};}
      const media=createRoot(document.getElementById('media'));window.renderMedia=(url,kind='video')=>media.render(React.createElement(StrictMode,null,React.createElement(PreviewPaneMediaContent,{source:{kind},loading:false,url,error:null,labels:{loading:'loading',unavailable:'unavailable',unsupported:'unsupported'},onMediaLoadedMetadata:()=>window.loaded=(window.loaded||0)+1})));
      window.closeMedia=()=>media.render(null);
      const pdf=createRoot(document.getElementById('pdf'));window.pdfReads=[];window.pdfGates=[];window.pdfErrors=[];
      const bytes=new Uint8Array(${JSON.stringify(pdfFixture())});
      window.renderPdf=id=>{const source={totalBytes:bytes.length,requestRange:async(offset,length)=>{window.pdfReads.push(id);await new Promise(done=>window.pdfGates.push(done));return bytes.slice(offset,offset+length);}};pdf.render(React.createElement(StrictMode,null,React.createElement(PdfViewer,{source,onLoadError:error=>window.pdfErrors.push(error.message)})));};
      window.releasePdf=()=>{for(const done of window.pdfGates.splice(0))done();};window.closePdf=()=>pdf.render(null);
      const terminals=createRoot(document.getElementById('terminals'));
      window.acks=[];window.flowStarts=[];
      const service={create:async()=>({id:'pty-'+(++window.created),shell:'cmd.exe',fontFamily:'monospace',outputFlowControl:true}),resize:async()=>{},write:async()=>{},dispose:async({id})=>window.disposed.push(id),beginOutputFlowControl:async({id})=>window.flowStarts.push(id),acknowledgeOutput:async ack=>window.acks.push(ack),onDynamicOutput:id=>fn=>{window.data.set(id,fn);return{dispose(){window.data.delete(id);}}},onDynamicExit:id=>fn=>({dispose(){}})};
      const labels=()=>{};const services={terminalService:service};
      window.renderTerminals=(count,visible=true)=>terminals.render(Array.from({length:count},(_,i)=>React.createElement('div',{key:i,style:{width:640,height:300,display:visible?'block':'none'}},React.createElement(TerminalSession,{sessionId:'tab-'+i,persistentKey:'tab-'+i,workspaceKey:'scope-'+i,services,cwd:'fixture',isVisible:visible,onShellLabelChange:labels,onOpenBrowserUrl:labels}))));
      window.flushTerminal=key=>new Promise(done=>registry.get(key).term.write('',done));
    `,
        },
        outfile: join(directory, "fixture.js"),
        bundle: true,
        format: "iife",
        platform: "browser",
        jsx: "automatic",
        define: { "process.env.NODE_ENV": JSON.stringify(mode) },
        logLevel: "silent",
        plugins: [
          {
            name: "ui-ports",
            setup(builder) {
              const stubs = {
                "@/logger.js":
                  "export const logger={info(){},debug(){},warn(){},error(){}};export const logMemoryDiagnostics=()=>{};",
                "@/i18n/IntlProvider.js":
                  "export const useLCodeIntl=()=>({intl:{formatMessage:()=> 'exited'}});",
                "@/components/ui/context-menu.js":
                  "import React from'react';export const ContextMenu=({children})=>children;export const ContextMenuTrigger=({children})=>children;export const ContextMenuContent=()=>null;export const ContextMenuItem=()=>null;",
              };
              builder.onResolve({ filter: /.*/ }, (args) =>
                args.path in stubs
                  ? { path: args.path, namespace: "port", pluginData: stubs[args.path] }
                  : undefined,
              );
              builder.onResolve({ filter: /pdf\.worker\.min\.mjs\?url$/ }, () => ({
                path: "pdf-worker",
                namespace: "port",
                pluginData: "export default '/pdf-worker.js'",
              }));
              builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
              builder.onLoad({ filter: /.*/, namespace: "port" }, (args) => ({
                contents: args.pluginData,
                loader: "js",
                resolveDir: desktopRoot,
              }));
            },
          },
        ],
      });
      const bundle = await readFile(join(directory, "fixture.js"));
      const video = await readFile(join(desktopRoot, "assets/startup-media/baili-lite.mp4"));
      const pdfWorker = await readFile(require.resolve("pdfjs-dist/build/pdf.worker.min.mjs"));
      server = createServer((request, response) => {
        if (request.url === "/pdf-worker.js") {
          response.setHeader("Content-Type", "text/javascript");
          response.end(pdfWorker);
        } else if (request.url.startsWith("/video")) {
          response.setHeader("Content-Type", "video/mp4");
          response.end(video);
        } else if (request.url === "/fixture.js") {
          response.setHeader("Content-Type", "text/javascript");
          response.end(bundle);
        } else
          response.end(
            '<!doctype html><div id="media"></div><div id="pdf" style="width:400px;height:400px"></div><div id="terminals"></div><script src="/fixture.js"></script>',
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
      await page.waitForFunction(() => !!window.renderMedia);
      await page.evaluate(() => window.renderMedia("/video-a.mp4"));
      await page.waitForFunction(() => document.querySelector("video")?.readyState >= 1);
      await page.evaluate(() => {
        document.querySelector("video").dataset.resourceId = "old";
        window.renderMedia("/video-b.mp4");
      });
      await page.waitForFunction(
        () =>
          document.querySelector("video")?.getAttribute("src") === "/video-b.mp4" &&
          document.querySelector("video").readyState >= 1,
      );
      assert.ok(
        await page.evaluate(() =>
          window.mediaEvents.some(
            ([method, id, src]) => method === "load" && id === "old" && src === null,
          ),
        ),
      );
      await page.evaluate(() => {
        document.querySelector("video").dataset.resourceId = "current";
        window.closeMedia();
      });
      await page.waitForFunction(() => !document.querySelector("video"));
      assert.ok(
        await page.evaluate(() =>
          window.mediaEvents.some(
            ([method, id, src]) => method === "load" && id === "current" && src === null,
          ),
        ),
      );
      await page.evaluate(() => window.renderPdf(1));
      await page.waitForFunction(() => window.pdfReads.includes(1));
      await page.evaluate(() => window.renderPdf(2));
      await page.waitForFunction(() => window.pdfReads.includes(2));
      await page.evaluate(() => window.releasePdf());
      await page.locator(".react-pdf__Page canvas").waitFor();
      assert.deepEqual(await page.evaluate(() => window.pdfErrors), []);
      await page.evaluate(() => window.closePdf());
      await page.waitForFunction(() => !document.querySelector(".react-pdf__Document"));
      await page.evaluate(() => window.renderTerminals(6));
      await page.waitForFunction(() => window.created === 6 && window.data.size === 6);
      await page.evaluate(async () => {
        for (const [id, write] of window.data) {
          const data = Array.from({ length: 6000 }, (_, i) => "row-" + i + "\r\n").join("");
          write({ data, flow: { leaseId: id, offset: data.length } });
        }
        await Promise.all(Array.from({ length: 6 }, (_, i) => window.flushTerminal("tab-" + i)));
      });
      await page.waitForFunction(() => window.acks.length === 6);
      assert.equal(await page.evaluate(() => window.flowStarts.length), 6);
      const before = await page.evaluate(() =>
        Array.from({ length: 6 }, (_, i) => {
          const term = window.registry.get("tab-" + i).term;
          return {
            length: term.buffer.active.length,
            limit: term.options.scrollback + term.rows,
            last: term.buffer.active
              .getLine(term.buffer.active.length - 2)
              ?.translateToString(true),
          };
        }),
      );
      for (const item of before) {
        assert.ok(item.length <= item.limit);
        assert.equal(item.last, "row-5999");
      }
      await page.evaluate(() => window.renderTerminals(0));
      await page.waitForFunction(
        () => document.querySelector("[data-side-pane-terminal-stash]")?.children.length === 6,
      );
      await page.evaluate(() => window.renderTerminals(6));
      await page.waitForFunction(
        () => !document.querySelector("[data-side-pane-terminal-stash]")?.children.length,
      );
      assert.equal(
        await page.evaluate(() => window.created),
        6,
        "remount reuses each original PTY",
      );
      await page.evaluate(() => {
        window.renderTerminals(0);
      });
      await page.waitForFunction(
        () => document.querySelector("[data-side-pane-terminal-stash]")?.children.length === 6,
      );
      await page.evaluate(() => window.registry.clearForTest());
      assert.equal(await page.locator("[data-side-pane-terminal-stash]").count(), 0);
      assert.equal(await page.evaluate(() => window.data.size), 0);
      assert.equal(await page.evaluate(() => window.disposed.length), 6);
    },
  );
