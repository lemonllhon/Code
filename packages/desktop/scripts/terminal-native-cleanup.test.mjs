import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

test(
  "Windows PTYs naturally release native workers after legacy and framed output completes",
  {
    skip: process.platform !== "win32",
    timeout: 45_000,
  },
  async (t) => {
    const root = resolve(import.meta.dirname, "../../..");
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--test", "packages/services/src/terminal/terminalPty.smoke.test.ts"],
      {
        cwd: root,
        windowsHide: true,
        env: {
          ...process.env,
          NODE_TEST_CONTEXT: undefined,
          TSX_TSCONFIG_PATH: resolve(root, "packages/ui/tsconfig.json"),
        },
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
    const result = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => done({ code, signal }));
    });
    // onExit 断言成功仍可能遗留原生 Worker；必须等待整个驱动自然退出，不能强制 exit。
    assert.deepEqual(result, { code: 0, signal: null }, output);
    assert.match(output, /pass 4/);
  },
);
