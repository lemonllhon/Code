import assert from "node:assert/strict";
import test from "node:test";
import { runtimeMemoryBudget } from "@lcode/shared/node";
import { LCodeAgentProcessManager } from "./lcodeAgentProcessManager.js";

const script = `
const lines=require('node:readline').createInterface({input:process.stdin});let held;
lines.on('line',line=>{const m=JSON.parse(line);if(m.method&&m.params?.reverse){held=m.id;process.stdout.write(JSON.stringify({id:'host-request',method:'fixture/reverse'})+'\\n');}
else if(m.id==='host-request'){process.stdout.write(JSON.stringify({id:held,result:{pid:process.pid}})+'\\n');}
else if(m.method)process.stdout.write(JSON.stringify({id:m.id,result:{pid:process.pid}})+'\\n');});
lines.on('close',()=>process.exit(0));`;

test(
  "辅助泳道在长 RPC/反向请求期间不回收，结清后退出并按需重开",
  { timeout: 15_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const reservations = new Set<symbol>();
    const released = Promise.withResolvers<void>();
    t.mock.method(runtimeMemoryBudget, "acquire", async () => {
      const token = Symbol();
      reservations.add(token);
      return {
        heapMb: 128,
        release: () => {
          reservations.delete(token);
          released.resolve();
        },
      };
    });
    const exited = Promise.withResolvers<void>();
    const manager = new LCodeAgentProcessManager({
      lane: "plugin",
      idleTimeoutMs: 100,
      requestTimeoutMs: 5000,
      commandResolver: () => ({ command: process.execPath, args: ["-e", script] }),
      onProcessCleanupCompleted: async () => {
        exited.resolve();
      },
    });
    t.after(async () => {
      await manager.disposeAllAndWait();
      assert.equal(reservations.size, 0);
    });
    const workspace = { workspacePath: process.cwd(), workspaceIdentity: "idle-synthetic" };
    const client = await manager.getClient(workspace);
    const reverse = Promise.withResolvers<void>();
    client.onRequest(() => reverse.resolve());
    const request = client.request<{ pid: number }>("runtime/capabilities", { reverse: true });
    await reverse.promise;
    t.mock.timers.tick(1000);
    assert.equal(client.isDisposed, false);
    assert.equal(client.pendingHostRequestCount, 1);
    await client.respond("host-request", {});
    const first = await request;
    t.mock.timers.tick(99);
    assert.equal(client.isDisposed, false);
    t.mock.timers.tick(1);
    await exited.promise;
    await released.promise;
    assert.equal(client.isDisposed, true);
    assert.equal(reservations.size, 0);
    const next = await manager.getClient(workspace);
    assert.notEqual(next, client);
    assert.notEqual(
      (await next.request<{ pid: number }>("runtime/capabilities", {})).pid,
      first.pid,
    );
  },
);
