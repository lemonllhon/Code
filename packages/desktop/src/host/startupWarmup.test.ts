import assert from "node:assert/strict";
import test from "node:test";
import { parseHostIncomingMessageEvent } from "./hostMessagePortGuard.js";
import { resolveHostAgentWarmupTargets } from "./hostInitialization.js";

const base = {
  type: "init-local",
  lcodeBuiltinProviderConfigFilePath: "fixture.json",
  workspacePath: "/project",
};

test("生产接收边界保留空名单、拒绝多个预热目标并关闭端口", () => {
  const result = parseHostIncomingMessageEvent({
    data: { ...base, agentWarmupTargets: [] },
    ports: [],
  });
  assert.equal(result.success, true);
  let closed = 0;
  const rejected = parseHostIncomingMessageEvent({
    data: { ...base, agentWarmupTargets: [{ workspacePath: "/a" }, { workspacePath: "/b" }] },
    ports: [
      {
        close: () => {
          closed++;
        },
      },
    ],
  });
  assert.equal(rejected.success, false);
  assert.equal(closed, 1);
});

test("空名单明确不预热；仅旧缺省调用回退且保留 identity", () => {
  assert.deepEqual(resolveHostAgentWarmupTargets({ ...base, agentWarmupTargets: [] }), []);
  assert.deepEqual(resolveHostAgentWarmupTargets({ ...base, workspaceIdentity: "isolated" }), [
    { workspacePath: "/project", workspaceIdentity: "isolated" },
  ]);
  assert.deepEqual(resolveHostAgentWarmupTargets({}), []);
  assert.deepEqual(
    resolveHostAgentWarmupTargets({ ...base, agentWarmupTargets: [{ workspacePath: "/b" }] }),
    [{ workspacePath: "/b" }],
  );
});
