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
  "source management hides retired builtin subscription while personal sources remain usable",
  { timeout: 30_000 },
  async (t) => {
    const cache = join(desktopRoot, "node_modules/.cache");
    await mkdir(cache, { recursive: true });
    const directory = await mkdtemp(join(cache, "plugin-source-retirement-"));
    let browser, server;
    t.after(async () => {
      await browser?.close();
      await new Promise((done) => (server ? server.close(done) : done()));
      await cleanupFixtureDirectory(directory);
    });
    const source = resolve(
      desktopRoot,
      "../ui/src/settings/PluginStoreSourcesDialog.tsx",
    ).replaceAll("\\", "/");
    await build({
      stdin: {
        resolveDir: desktopRoot,
        contents: `
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {PluginStoreSourcesDialog} from ${JSON.stringify(source)};
      window.actions=[];const root=createRoot(document.getElementById('root'));
      const builtin={id:'zcode-plugins-official',name:'Retired subscription',source:{source:'builtin'},pluginCount:4};
      const personal={id:'personal',name:'Personal source',source:{source:'directory',path:'/fixture'},pluginCount:2};
      window.renderSources=(personalVisible=true)=>root.render(React.createElement(PluginStoreSourcesDialog,{
        open:true,onOpenChange:()=>{},marketplaces:personalVisible?[builtin,personal]:[builtin],operationId:null,
        onUpdateMarketplace:id=>window.actions.push(['refresh',id]),onRemoveMarketplace:id=>window.actions.push(['remove',id])}));
      window.renderSources();
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
          name: "source-dialog-ui-ports",
          setup(builder) {
            const stubs = {
              "@/components/ui/button.js":
                "import React from 'react';export const Button=({variant,size,...props})=>React.createElement('button',props);",
              "@/components/ui/dialog.js":
                "import React from 'react';export const Dialog=({children})=>children;export const DialogContent=props=>React.createElement('section',props);export const DialogTitle=props=>React.createElement('h1',props);",
              "@/i18n/IntlProvider.js":
                "export const useLCodeIntl=()=>({locale:'en-US',intl:{formatMessage:({id})=>id}});",
              "@/settings/pluginSourceLabel.js":
                "export const resolveMarketplaceDisplayName=(id,items)=>items.find(x=>x.id===id).name;",
              "@/settings/pluginStoreListing.js":
                "export const sortMarketplaceSources=items=>items;export const isPublicStoreMarketplaceId=id=>id==='zcode-plugins-official';",
            };
            builder.onResolve({ filter: /.*/ }, (args) =>
              args.path in stubs
                ? { path: args.path, namespace: "ports", pluginData: stubs[args.path] }
                : undefined,
            );
            builder.onLoad({ filter: /.*/, namespace: "ports" }, (args) => ({
              contents: args.pluginData,
              loader: "js",
              resolveDir: desktopRoot,
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
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('[data-testid="plugin-store-source-row"]').waitFor();
    assert.equal(await page.locator('[data-testid="plugin-store-source-row"]').count(), 1);
    assert.equal(await page.getByText("Retired subscription").count(), 0);
    await page.locator('[data-testid="plugin-store-source-update"]').click();
    await page.locator('[data-testid="plugin-store-source-remove"]').click();
    assert.deepEqual(await page.evaluate(() => window.actions), [
      ["refresh", "personal"],
      ["remove", "personal"],
    ]);
    await page.evaluate(() => window.renderSources(false));
    await page.getByText("settings.plugins.store.sources.empty").waitFor();
    assert.equal(await page.locator('[data-testid="plugin-store-source-row"]').count(), 0);
  },
);
