import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteWorkspaceSessionEntry } from "@lcode/shared";
import { buildRemoteDevices } from "./remoteDevices.js";

const target = { kind: "ssh" as const, host: "example.invalid", username: "fixture", port: 22 };
function entry(path: string, remoteTarget = target): RemoteWorkspaceSessionEntry {
  return {
    kind: "remote",
    target: remoteTarget,
    workspacePath: path,
    lastOpenedAt: 1,
    lastConnectionStatus: "connected",
  };
}

test("同设备项目聚合，历史成功不能冒充当前在线，临时连接可显示零项目", () => {
  const devices = buildRemoteDevices([entry("/one"), entry("/two")], []);
  assert.equal(devices.length, 1);
  assert.equal(devices[0]!.projects.length, 2);
  assert.equal(devices[0]!.connected, false);
  const live = buildRemoteDevices(
    [],
    [{ sessionId: "current", target: { ...target, password: "fixture-secret" } }],
  );
  assert.equal(live[0]!.connected, true);
  assert.equal(live[0]!.projects.length, 0);
  assert.equal(JSON.stringify(live).includes("fixture-secret"), false);
  assert.equal(
    buildRemoteDevices(
      [entry("/one")],
      [{ sessionId: "current", target: { ...target, password: "fixture-secret" } }],
    ).length,
    1,
  );
});

test("同路径不同主机和WSL用户隔离，代理配置沿用同一设备身份", () => {
  const histories: RemoteWorkspaceSessionEntry[] = [
    entry("/same"),
    entry("/same", { ...target, host: "other.invalid" }),
    { ...entry("/same"), target: { ...target, useProxy: true, proxyProfileId: "fixture-proxy" } },
    { ...entry("/same"), target: { kind: "wsl", distro: "Fixture", user: "root" } },
    { ...entry("/same"), target: { kind: "wsl", distro: "Fixture", user: "user" } },
  ];
  assert.equal(buildRemoteDevices(histories, []).length, 4);
});

test("独立配置可零项目保存；移除后历史不复活，同地址的独立档案不串用连接", () => {
  const profiles = ["a", "b"].map((id) => ({ id, name: id, revision: 1, target }));
  const devices = buildRemoteDevices([], [{ sessionId: "one", deviceId: "b", target }], profiles);
  assert.equal(devices[0]!.connected, false);
  assert.equal(devices[1]!.connected, true);
  assert.deepEqual(devices[1]!.sessionIds, ["one"]);
  assert.equal(devices[1]!.projects.length, 0);
  assert.deepEqual(buildRemoteDevices([entry("/old")], [], []), []);
  assert.ok(
    buildRemoteDevices([], [{ sessionId: "legacy", target }], profiles).every(
      (device) => !device.connected,
    ),
  );
});
