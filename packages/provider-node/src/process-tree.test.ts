import assert from "node:assert/strict";
import test from "node:test";
import { terminateNodeProcessTree } from "./process-tree.js";

for (const platform of ["win32", "darwin", "linux"] as const)
  test(`owned process tree ${platform} uses bounded OS cleanup`, async () => {
    const live = new Set([710001, 710002, 710003]);
    const signals: number[] = [],
      commands: string[] = [];
    await terminateNodeProcessTree(710001, {
      platform,
      kill: ((pid: number, signal: string | number) => {
        if (!live.has(pid)) throw Object.assign(new Error("gone"), { code: "ESRCH" });
        if (signal !== 0) {
          signals.push(pid);
          live.delete(pid);
        }
        return true;
      }) as typeof process.kill,
      execFile: async (file, args, options) => {
        commands.push(file);
        assert.ok(Number(options.timeout) > 0);
        if (platform === "win32") {
          assert.equal(file, "taskkill");
          assert.deepEqual(args, ["/PID", "710001", "/T", "/F"]);
          assert.equal(options.windowsHide, true);
          live.clear();
          return { status: 0, stdout: "", stderr: "" };
        }
        if (file === "ps") {
          assert.deepEqual(
            args,
            platform === "darwin" ? ["-axo", "pid=,ppid="] : ["-eo", "pid=,ppid="],
          );
          return { status: 0, stdout: "", stderr: "" };
        }
        assert.equal(file, "pgrep");
        const pid = Number(args[1]);
        return {
          status: 0,
          stdout: pid === 710001 ? "710002" : pid === 710002 ? "710003" : "",
          stderr: "",
        };
      },
    });
    assert.equal(live.size, 0);
    if (platform !== "win32") assert.deepEqual(signals, [710003, 710002, 710001]);
    assert.ok(commands.length);
  });

test("process cleanup refuses invalid and current process identifiers", async () => {
  for (const pid of [0, -1, NaN, process.pid])
    await assert.rejects(terminateNodeProcessTree(pid), /Invalid owned process/);
});
