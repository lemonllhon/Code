import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { cleanupFixtureDirectory, desktopRoot } from "./main-runtime-test-fixture.mjs";

test(
  "runtime collector uses isolated platform paths, pairs launches and records real process trees",
  { timeout: 90_000 },
  async (t) => {
    await mkdir(join(desktopRoot, "node_modules/.cache"), { recursive: true });
    const directory = await mkdtemp(join(desktopRoot, "node_modules/.cache/runtime-collector-"));
    t.after(() => cleanupFixtureDirectory(directory));
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name: "resource-fixture", version: "0.0.0", main: "main.cjs" }),
    );
    await writeFile(
      join(directory, "main.cjs"),
      `
    const {app,BrowserWindow}=require('electron');
    process.on('uncaughtException',error=>{process.stderr.write(error.message);app.exit(1)});
    app.whenReady().then(async()=>{
      const assert=require('node:assert/strict');
      const path=require('node:path');
      for(const key of ['appData','userData','sessionData'])assert.ok(app.getPath(key).startsWith(process.env.HOME));
      assert.equal(process.env.XDG_CONFIG_HOME,path.join(process.env.HOME,'config'));
      globalThis.fixtureWindow=new BrowserWindow({show:false});
      await globalThis.fixtureWindow.loadURL('data:text/html,<button data-testid="login-use-api-key-button">fixture</button>');
    }).catch(error=>{process.stderr.write(error.message);app.exit(1)});
    app.on('window-all-closed',()=>app.quit());
  `,
    );
    const root = resolve(desktopRoot, "../..");
    const child = spawn(
      process.execPath,
      [
        join(desktopRoot, "scripts/benchmark-desktop-runtime.mjs"),
        "--app",
        directory,
        "--trials",
        "1",
        "--output",
        join(directory, "reports"),
      ],
      {
        cwd: root,
        windowsHide: true,
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    const code = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("exit", done);
    });
    assert.equal(code, 0, output);
    const report = JSON.parse(
      await readFile(join(directory, "reports/runtime-report.json"), "utf8"),
    );
    assert.equal(report.complete, true);
    assert.equal(report.readiness, "login-ready");
    assert.deepEqual(
      report.trials.map((trial) => trial.mode),
      ["cold", "warm"],
    );
    for (const trial of report.trials) {
      assert.equal(trial.build.version, "0.0.0");
      assert.ok(trial.readyMs > 0);
      assert.equal(trial.observations.length, 3);
      for (const sample of trial.observations) {
        assert.ok(sample.processes.length > 0);
        assert.ok(sample.osTree.length > 0);
        assert.ok(sample.osTree.every((row) => row.rssKb >= 0));
      }
    }
  },
);
