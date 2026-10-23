import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { queryCronSchedulerDemand } from "./cronSchedulerDemandQuery.js";

test("demand query matches source and request, rejects unknown/exit and removes listeners", async () => {
  class Host extends EventEmitter {
    requestId = "";
    postMessage(message: { requestId: string }) {
      this.requestId = message.requestId;
    }
  }
  const host = new Host();
  const query = queryCronSchedulerDemand(host);
  host.emit("message", {
    type: "cron-scheduler-demand-result",
    requestId: "other",
    demand: "empty",
  });
  host.emit("message", {
    type: "cron-scheduler-demand-result",
    requestId: host.requestId,
    demand: "invalid",
  });
  assert.equal(host.listenerCount("message"), 1);
  host.emit("message", {
    type: "cron-scheduler-demand-result",
    requestId: host.requestId,
    demand: "needed",
  });
  assert.equal(await query, true);
  assert.equal(host.listenerCount("message"), 0);
  assert.equal(host.listenerCount("exit"), 0);
  const notReady = queryCronSchedulerDemand(host);
  host.emit("message", {
    type: "cron-scheduler-demand-result",
    requestId: host.requestId,
    demand: "not-ready",
  });
  assert.equal(await notReady, null, "storage migration is not an empty or schedulable database");
  const unknown = assert.rejects(queryCronSchedulerDemand(host), /unavailable/);
  host.emit("message", {
    type: "cron-scheduler-demand-result",
    requestId: host.requestId,
    demand: "unknown",
  });
  await unknown;
  const exit = assert.rejects(queryCronSchedulerDemand(host), /unavailable/);
  host.emit("exit", 1);
  await exit;
  assert.equal(host.listenerCount("message"), 0);
  assert.equal(host.listenerCount("exit"), 0);
});
