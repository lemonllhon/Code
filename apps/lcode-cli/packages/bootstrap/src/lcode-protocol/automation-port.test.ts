import assert from "node:assert/strict";
import test from "node:test";
import { lcodeProtocolMethods } from "@lcode/shared";
import { createProtocolAutomationPort } from "./automation-port.js";
import type {
  LCodeProtocolAgentServerContext,
  LCodeProtocolSessionRecord,
} from "./server-types.js";

function fixture() {
  const requests: { method: string; params: unknown }[] = [];
  const record = { activeAutomationId: "automation-self" } as LCodeProtocolSessionRecord;
  const context = {
    requestClient: async (method: string, params: unknown) => {
      requests.push({ method, params });
      return { deleted: true };
    },
  } as unknown as LCodeProtocolAgentServerContext;
  return { record, requests, port: createProtocolAutomationPort(context, () => record) };
}

test("session automation port permits only deletion of the active automation", async () => {
  const f = fixture();
  assert.equal(await f.port.delete({ id: "automation-self" }), true);
  await assert.rejects(f.port.delete({ id: "automation-other" }), /only delete itself/i);
  assert.deepEqual(f.requests, [
    {
      method: lcodeProtocolMethods.automationDelete,
      params: { automationId: "automation-self" },
    },
  ]);
});

test("session automation port still rejects creation and updates in scheduled turns", async () => {
  const f = fixture();
  await assert.rejects(f.port.create({} as never), /while running a scheduled task/i);
  await assert.rejects(
    f.port.update({ id: "automation-self", title: "changed" }),
    /while running a scheduled task/i,
  );
  assert.deepEqual(f.requests, []);
});

test("clearing turn attribution restores ordinary user deletion", async () => {
  const f = fixture();
  await f.port.delete({ id: "automation-self" });
  // 删除定义不能清理本轮归因；直到本轮结束，后续调用仍受自删除约束。
  await assert.rejects(f.port.delete({ id: "automation-other" }), /only delete itself/i);
  f.record.activeAutomationId = undefined;
  assert.equal(await f.port.delete({ id: "automation-other" }), true);
});

test("per-call attribution survives interleaved session admission without widening deletion", async () => {
  const f = fixture();
  const execution = { automationTurn: true, automationId: "automation-self" };
  f.record.activeAutomationId = "automation-other";
  assert.equal(await f.port.delete({ id: "automation-self" }, execution), true);
  await assert.rejects(f.port.delete({ id: "automation-other" }, execution), /only delete itself/i);
  f.record.activeAutomationId = undefined;
  await assert.rejects(f.port.delete({ id: "automation-other" }, execution), /only delete itself/i);
  assert.equal(f.requests.length, 1);
});

test("a scheduled call without its own id cannot borrow session attribution", async () => {
  const f = fixture();
  await assert.rejects(
    f.port.delete({ id: "automation-self" }, { automationTurn: true }),
    /only delete itself/i,
  );
  assert.deepEqual(f.requests, []);
});

test("explicit user-call attribution does not inherit an in-flight session marker", async () => {
  const f = fixture();
  assert.equal(await f.port.delete({ id: "automation-other" }, { automationTurn: false }), true);
  assert.equal(f.requests.length, 1);
});

test("scheduled per-call attribution blocks creation and updates even after session cleanup", async () => {
  const f = fixture();
  f.record.activeAutomationId = undefined;
  const execution = { automationTurn: true, automationId: "automation-self" };
  await assert.rejects(f.port.create({} as never, execution), /while running a scheduled task/i);
  await assert.rejects(
    f.port.update({ id: "automation-self", title: "changed" }, execution),
    /while running a scheduled task/i,
  );
  assert.deepEqual(f.requests, []);
});
