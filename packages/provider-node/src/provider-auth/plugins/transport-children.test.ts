import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { PluginWorkerTransport } from "./transport.js";

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
for (const crash of [false, true])
  test(
    `worker ${crash ? "crash" : "dispose"} reaps its CLI grandchildren`,
    { timeout: 15_000 },
    async (t) => {
      const grandSource = "process.send(process.pid);setInterval(()=>{},1000)";
      const rootSource = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(grandSource)}],{stdio:['ignore','ignore','ignore','ipc']});child.once('message',grand=>process.send({grand}));setInterval(()=>{},1000);`;
      const worker = new Worker(
        `const {parentPort}=require('node:worker_threads');const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e',${JSON.stringify(rootSource)}],{stdio:['ignore','ignore','ignore','ipc']});
      parentPort.postMessage({kind:'child-start',id:child.pid});
      child.once('message',({grand})=>parentPort.postMessage({kind:'fixture-ready',root:child.pid,grand}));
      parentPort.on('message',m=>{if(m.kind==='dispose')process.exit(0);if(m.kind==='fixture-crash')process.exit(2)});`,
        { eval: true, stdout: true, stderr: true, execArgv: [] },
      );
      const ready = new Promise<{ root: number; grand: number }>((resolve) =>
        worker.on("message", (m) => {
          if (m.kind === "fixture-ready") resolve(m);
        }),
      );
      const transport = new PluginWorkerTransport(
        "fixture",
        undefined,
        undefined,
        undefined,
        undefined,
        { worker },
      );
      const pids = await ready;
      t.after(async () => {
        for (const pid of [pids.grand, pids.root])
          if (alive(pid)) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              /* fixture already exited */
            }
          }
        await transport.dispose().catch(() => {});
      });
      if (crash) {
        const exiting = once(worker, "exit");
        worker.postMessage({ kind: "fixture-crash" });
        await exiting;
        await assert.rejects(transport.dispose());
      } else await transport.dispose();
      assert.equal(alive(pids.grand), false, "CLI grandchild survived owner shutdown");
      assert.equal(alive(pids.root), false);
    },
  );
