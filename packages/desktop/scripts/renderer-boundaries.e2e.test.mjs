import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { _electron } from "playwright-core";
import { cleanupFixtureDirectory, desktopRoot } from "./main-runtime-test-fixture.mjs";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsup"))("esbuild");

test(
  "cold metadata recovery runs in the Renderer UI regression entry",
  { timeout: 40_000 },
  async () => {
    await promisify(execFile)(
      process.execPath,
      ["--test", resolve(desktopRoot, "scripts/active-task-metadata.e2e.test.mjs")],
      {
        cwd: resolve(desktopRoot, "../.."),
        timeout: 35_000,
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      },
    );
  },
);

test(
  "isolated Electron Renderer uses the real preload and shared startup drawing",
  { timeout: 60_000 },
  async (t) => {
    const cache = join(desktopRoot, "node_modules/.cache");
    await mkdir(cache, { recursive: true });
    const directory = await mkdtemp(join(cache, "renderer-boundaries-e2e-"));
    let electron;
    t.after(async () => {
      await electron?.close();
      await cleanupFixtureDirectory(directory);
    });
    const source = (path) => JSON.stringify(resolve(desktopRoot, path).replaceAll("\\", "/"));
    async function compile(contents, output, options = {}) {
      const result = await build({
        stdin: { contents, resolveDir: desktopRoot },
        outfile: join(directory, output),
        bundle: true,
        format: "cjs",
        platform: "node",
        external: ["electron"],
        metafile: true,
        logLevel: "silent",
        ...options,
      });
      for (const artifact of Object.values(result.metafile.outputs))
        assert.ok(
          !artifact.imports.some(({ external, path }) => external && path.startsWith("@lcode/")),
          "Electron fixtures must bundle workspace TypeScript imports",
        );
    }
    await compile(`import ${source("src/preload/index.ts")};`, "preload.cjs");
    await compile(
      `
    import {sampleSceneContours,createSceneFragments} from ${source("src/renderer/src/startup/sceneContours.ts")};
    import {drawAemeathPortrait} from ${source("src/renderer/src/startup/aemeathPortrait.ts")};
    window.startupDrawing={sampleSceneContours,createSceneFragments,drawAemeathPortrait};
  `,
      "drawing.js",
      { format: "iife", platform: "browser" },
    );
    await writeFile(
      join(directory, "index.html"),
      '<!doctype html><meta charset="utf-8"><input type="file"><script src="./drawing.js"></script>',
    );
    await writeFile(join(directory, "attachment.txt"), "renderer bridge fixture");
    await compile(
      `
    const {app,BrowserWindow,ipcMain}=require('electron');
    const {PlatformChannels}=require('@lcode/shared');
    process.on('uncaughtException',error=>{console.error(error);app.exit(1)});
    process.on('unhandledRejection',error=>{console.error(error);app.exit(1)});
    app.setPath('userData',${JSON.stringify(join(directory, "profile"))});
    app.disableHardwareAcceleration();
    ipcMain.handle(PlatformChannels.BindRemoteWorkspaceSessionContext,(_event,context)=>{
      globalThis.receivedScope=context;
    });
    ipcMain.handle(PlatformChannels.BrowserViewAttachGuest,(_event,payload)=>{
      globalThis.receivedGuest=payload;return {ok:true,guestGeneration:7};
    });
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,
        preload:${JSON.stringify(join(directory, "preload.cjs"))}}});
      await win.loadFile(${JSON.stringify(join(directory, "index.html"))});
    });
    app.on('window-all-closed',()=>app.quit());
  `,
      "main.cjs",
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    electron = await _electron.launch({
      executablePath: require("electron"),
      args: [join(directory, "main.cjs")],
      env,
    });
    const page = await electron.firstWindow();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForFunction(() => window.lcode && window.startupDrawing);
    await t.test(
      "File crosses contextBridge safely and Node globals remain unavailable",
      async () => {
        assert.deepEqual(await page.evaluate(() => [typeof process, typeof require]), [
          "undefined",
          "undefined",
        ]);
        assert.deepEqual(
          await page.evaluate(() =>
            [null, {}, "file", new Blob(), new File(["x"], "unsaved.txt")].map((value) =>
              window.lcode.getPathForFile(value),
            ),
          ),
          [null, null, null, null, null],
        );
        const path = join(directory, "attachment.txt");
        await page.locator("input").setInputFiles(path);
        assert.equal(
          await page
            .locator("input")
            .evaluate((input) => window.lcode.getPathForFile(input.files[0])),
          path,
        );
      },
    );
    await t.test(
      "remote identity and guest generation retain their distinct IPC results",
      async () => {
        const scope = {
          remoteSessionId: "remote-session",
          workspacePath: "/workspace",
          workspaceIdentity: "scope",
        };
        const guest = {
          key: "tab",
          webContentsId: 19,
          workspaceKey: "scope",
          remoteSessionId: "remote-session",
          sessionId: "child",
        };
        assert.equal(
          await page.evaluate(
            (scope) => window.lcode.bindRemoteWorkspaceSessionContext(scope),
            scope,
          ),
          undefined,
        );
        assert.deepEqual(
          await page.evaluate((guest) => window.lcode.browserViewAttachGuest(guest), guest),
          { ok: true, guestGeneration: 7 },
        );
        assert.deepEqual(await electron.evaluate(() => globalThis.receivedScope), scope);
        assert.deepEqual(await electron.evaluate(() => globalThis.receivedGuest), guest);
      },
    );
    await t.test(
      "actual Canvas keeps portrait pixels outside the eye patches unchanged",
      async () => {
        const pixels = await page.evaluate(async () => {
          const canvas = document.createElement("canvas");
          canvas.width = 1536;
          canvas.height = 1024;
          const ctx = canvas.getContext("2d");
          const image = async (color) => {
            ctx.fillStyle = color;
            ctx.fillRect(0, 0, 1536, 1024);
            const image = new Image();
            image.src = canvas.toDataURL();
            await image.decode();
            return image;
          };
          const open = await image("red"),
            closed = await image("blue");
          const sample = (closure) => {
            window.startupDrawing.drawAemeathPortrait(ctx, open, closed, closure);
            return {
              eye: [...ctx.getImageData(600, 380, 1, 1).data],
              outside: [...ctx.getImageData(30, 30, 1, 1).data],
              alpha: ctx.globalAlpha,
            };
          };
          return [sample(0), sample(1), sample(0.5), sample(0)];
        });
        for (const result of pixels) {
          assert.deepEqual(result.outside, [255, 0, 0, 255]);
          assert.equal(result.alpha, 1);
        }
        assert.deepEqual(pixels[0].eye, [255, 0, 0, 255]);
        assert.deepEqual(pixels[1].eye, [0, 0, 255, 255]);
        assert.ok(Math.abs(pixels[2].eye[0] - 127) <= 1 && Math.abs(pixels[2].eye[2] - 128) <= 1);
        assert.deepEqual(pixels[3], pixels[0]);
      },
    );
    await t.test("decoded image contours and fragments draw finite continuous paths", async () => {
      const result = await page.evaluate(async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 768;
        canvas.height = 512;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "black";
        ctx.fillRect(0, 0, 768, 512);
        ctx.fillStyle = "white";
        ctx.fillRect(40, 40, 680, 420);
        const image = new Image();
        image.src = canvas.toDataURL();
        await image.decode();
        const paths = window.startupDrawing.sampleSceneContours(
          image,
          image.width,
          image.height,
          "black",
        );
        const pieces = window.startupDrawing.createSceneFragments(paths);
        ctx.clearRect(0, 0, 768, 512);
        ctx.strokeStyle = "white";
        ctx.scale(0.5, 0.5);
        for (const { points } of pieces) {
          ctx.beginPath();
          for (const [x, y] of points) ctx.lineTo(x, y);
          ctx.stroke();
        }
        return {
          paths: paths.length,
          pieces: pieces.length,
          finite: paths.flat(2).every(Number.isFinite),
          drawn: ctx.getImageData(0, 0, 768, 512).data.some((value) => value > 0),
        };
      });
      assert.ok(result.paths > 0 && result.pieces > 0 && result.finite && result.drawn);
    });
    assert.deepEqual(errors, []);
  },
);
