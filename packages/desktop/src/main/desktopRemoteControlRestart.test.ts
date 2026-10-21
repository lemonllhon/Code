import assert from "node:assert/strict";
import test from "node:test";
import { createRemoteControlController } from "./desktopRemoteControlController.js";
import type {
  RemoteControlTunnelDelegate,
  RemoteControlTunnelStartParams,
} from "./desktopRemoteControlTunnel.js";
import { REMOTE_CONTROL_RECOVERY_CREDENTIAL_KEY } from "./desktopRemoteControlStore.js";

function installation() {
  const values = new Map<string, string>();
  const connections: Array<{
    params: RemoteControlTunnelStartParams;
    delegate: RemoteControlTunnelDelegate;
    stopped: boolean;
  }> = [];
  const warnings: unknown[] = [];
  const attachedWindows: number[] = [];
  let pauseRead: (() => Promise<void>) | undefined;
  function boot() {
    return createRemoteControlController({
      logger: { info() {}, warn: (...args) => warnings.push(args), error() {} },
      credentialService: {
        load: async (key) => {
          if (key === REMOTE_CONTROL_RECOVERY_CREDENTIAL_KEY && pauseRead) {
            const pause = pauseRead;
            pauseRead = undefined;
            await pause();
          }
          return values.get(key) ?? null;
        },
        save: async (key, value) => {
          values.set(key, value);
        },
        delete: async (key) => {
          values.delete(key);
        },
      },
      broadcast() {},
      attachLocalWorkspaceSessionHost({ windowId }) {
        attachedWindows.push(windowId);
        return {
          attachmentId: "test-attachment",
          remoteKind: "local",
          process: { postMessage() {} },
          port: { on() {}, start() {}, close() {}, postMessage() {} },
        };
      },
      attachRemoteWorkspaceSessionHost() {
        throw new Error("not used by this test");
      },
      createTunnelSession(params, delegate) {
        const connection = { params, delegate, stopped: false };
        connections.push(connection);
        return {
          roomId: params.roomId,
          decide() {},
          revokeDevice() {},
          refreshPairing() {},
          closeBridge() {},
          stopRoom() {
            connection.stopped = true;
          },
          close() {},
          sendBridgeBinary() {},
          setTransportPaused() {},
          isBridged: () => false,
          isRunning: () => !connection.stopped,
          dispose() {
            connection.stopped = true;
          },
        };
      },
    });
  }
  async function authorize(persistentRoom = true) {
    const controller = boot();
    await controller.setConfig({ enabled: true });
    const result = await controller.startPairing({ target: { kind: "local", windowId: 1 } });
    assert.ok(result.success);
    const connection = connections.at(-1)!;
    connection.delegate.onRoomReady({
      type: "room.ready",
      proto: 1,
      roomId: connection.params.roomId,
      expiresAt: Date.now() + 300000,
      multiDevice: true,
      ...(persistentRoom ? { persistentRoom: true as const } : {}),
    });
    connection.delegate.onPairingAccepted({
      type: "pairing.accepted",
      requestId: "grant",
      roomId: connection.params.roomId,
      deviceId: "remembered-browser",
      deviceName: "Browser",
      credHash: "remembered-hash",
      grantedAt: Date.now(),
    });
    await controller.refreshDevices();
    return controller;
  }
  return {
    values,
    connections,
    warnings,
    attachedWindows,
    boot,
    authorize,
    pauseRecoveryRead(pause: () => Promise<void>) {
      pauseRead = pause;
    },
  };
}

test("正常退出后使用原房间、host token 和设备表恢复到新的窗口 Host", async () => {
  const app = installation();
  const first = await app.authorize();
  const original = app.connections[0]!.params;
  await first.dispose("normal-exit");
  const restarted = app.boot();
  await restarted.restorePairing(42);
  assert.equal(app.connections.length, 2);
  const restored = app.connections[1]!;
  assert.equal(restored.params.roomId, original.roomId);
  assert.equal(restored.params.hostToken, original.hostToken);
  assert.notEqual(restored.params.capHash, original.capHash);
  assert.deepEqual(restored.params.devices, [
    {
      deviceId: "remembered-browser",
      deviceName: "Browser",
      credHash: "remembered-hash",
    },
  ]);
  restored.delegate.onBridgeOpen({
    type: "bridge.open",
    proto: 1,
    deviceId: "remembered-browser",
    resumed: false,
  });
  assert.deepEqual(app.attachedWindows, [42]);
  await restarted.restorePairing(43);
  assert.equal(app.connections.length, 2);
  const snapshot = await restarted.getConfigSnapshot();
  assert.ok(!JSON.stringify(snapshot).includes(original.hostToken));
  await restarted.dispose("end");
  assert.deepEqual(app.warnings, []);
});

test("手动停止后重启保持停止；再次开启复用原入口和原设备授权", async () => {
  const app = installation();
  const first = await app.authorize();
  const original = app.connections[0]!.params;
  await first.stopPairing("user-stop");
  assert.equal((await first.refreshDevices()).devices.length, 1);
  await first.dispose("exit-after-stop");
  const restarted = app.boot();
  await restarted.restorePairing(42);
  assert.equal(app.connections.length, 1);
  await restarted.startPairing({ target: { kind: "local", windowId: 42 } });
  assert.equal(app.connections[1]!.params.roomId, original.roomId);
  assert.equal(app.connections[1]!.params.hostToken, original.hostToken);
  assert.equal(app.connections[1]!.params.devices[0]!.deviceId, "remembered-browser");
  await restarted.dispose("end");
});

test("禁用远控后重启不出站；重新启用本身不会撤销原设备", async () => {
  const app = installation();
  const first = await app.authorize();
  await first.setConfig({ enabled: false });
  await first.dispose("exit");
  const restarted = app.boot();
  await restarted.restorePairing(42);
  assert.equal(app.connections.length, 1);
  await restarted.setConfig({ enabled: true });
  await restarted.restorePairing(42);
  assert.equal(app.connections.length, 1);
  assert.equal((await restarted.refreshDevices()).devices.length, 1);
  await restarted.dispose("end");
});

test("旧 Worker 未确认稳定身份时不自动恢复、不复用可能已释放的房间", async () => {
  const app = installation();
  const first = await app.authorize(false);
  const original = app.connections[0]!.params;
  await first.dispose("exit");
  const restarted = app.boot();
  await restarted.restorePairing(42);
  assert.equal(app.connections.length, 1);
  await restarted.startPairing({ target: { kind: "local", windowId: 42 } });
  assert.notEqual(app.connections[1]!.params.roomId, original.roomId);
  assert.equal(app.connections[1]!.params.devices.length, 1);
  await restarted.dispose("end");
});

test("停止抢在异步启动恢复完成之前生效，迟到恢复不能重新开启远控", async () => {
  const app = installation();
  const first = await app.authorize();
  await first.dispose("exit");
  const restarted = app.boot();
  let release!: () => void;
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  app.pauseRecoveryRead(async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const restoring = restarted.restorePairing(42);
  await reading;
  const stopping = restarted.stopPairing("user-stop");
  release();
  await Promise.all([restoring, stopping]);
  assert.equal(app.connections.length, 1);
  assert.equal(
    JSON.parse(app.values.get(REMOTE_CONTROL_RECOVERY_CREDENTIAL_KEY)!).listening,
    false,
  );
  await restarted.dispose("end");
});

test("旧 room.ready 不会重新打开已停止的恢复意图，撤销设备后重启不重新注册该设备", async () => {
  const app = installation();
  const first = await app.authorize();
  await first.stopPairing("user-stop");
  const old = app.connections[0]!;
  old.delegate.onRoomReady({
    type: "room.ready",
    proto: 1,
    roomId: old.params.roomId,
    expiresAt: Date.now() + 300000,
    multiDevice: true,
    persistentRoom: true,
  });
  await first.dispose("exit");
  assert.equal(
    JSON.parse(app.values.get(REMOTE_CONTROL_RECOVERY_CREDENTIAL_KEY)!).listening,
    false,
  );
  const restarted = app.boot();
  await restarted.revokeDevice("remembered-browser");
  await restarted.restorePairing(42);
  assert.equal(app.connections.length, 1);
  assert.deepEqual((await restarted.refreshDevices()).devices, []);
  await restarted.dispose("end");
});

test("收到恢复 ACK 和授权后立即退出，退出屏障仍提交已接受的恢复记录", async () => {
  const app = installation();
  const first = app.boot();
  await first.setConfig({ enabled: true });
  await first.startPairing({ target: { kind: "local", windowId: 1 } });
  let release!: () => void;
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  app.pauseRecoveryRead(async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const original = app.connections[0]!;
  original.delegate.onRoomReady({
    type: "room.ready",
    proto: 1,
    roomId: original.params.roomId,
    expiresAt: Date.now() + 300000,
    multiDevice: true,
    persistentRoom: true,
  });
  original.delegate.onPairingAccepted({
    type: "pairing.accepted",
    requestId: "grant",
    roomId: original.params.roomId,
    deviceId: "remembered-browser",
    deviceName: "Browser",
    credHash: "remembered-hash",
    grantedAt: Date.now(),
  });
  const quitting = first.dispose("immediate-exit");
  await reading;
  release();
  await quitting;
  const restarted = app.boot();
  await restarted.restorePairing(42);
  assert.equal(app.connections.length, 2);
  assert.equal(app.connections[1]!.params.roomId, original.params.roomId);
  await restarted.dispose("end");
});

test("相同稳定房间再次开启后，旧隧道的迟到关闭/断桥/授权不能影响新连接", async () => {
  const app = installation();
  const first = await app.authorize();
  const old = app.connections[0]!;
  await first.stopPairing("manual-stop");
  await first.startPairing({ target: { kind: "local", windowId: 42 } });
  const current = app.connections[1]!;
  assert.equal(current.params.roomId, old.params.roomId);
  current.delegate.onRoomReady({
    type: "room.ready",
    proto: 1,
    roomId: current.params.roomId,
    expiresAt: Date.now() + 300000,
    multiDevice: true,
    persistentRoom: true,
  });
  current.delegate.onBridgeOpen({
    type: "bridge.open",
    proto: 1,
    deviceId: "remembered-browser",
    resumed: false,
  });
  old.delegate.onClosed({ code: 1006, reason: "late old close" });
  old.delegate.onBridgeOpen({
    type: "bridge.open",
    proto: 1,
    deviceId: "stale-device",
    resumed: false,
  });
  old.delegate.onBridgeDetached({ type: "bridge.detached", deviceId: "remembered-browser" });
  old.delegate.onPairingAccepted({
    type: "pairing.accepted",
    requestId: "old-grant",
    roomId: old.params.roomId,
    deviceId: "stale-device",
    deviceName: "Old",
    credHash: "old-hash",
    grantedAt: Date.now(),
  });
  assert.equal(first.getActiveState().hasBridge, true);
  assert.deepEqual(app.attachedWindows, [42]);
  assert.equal((await first.refreshDevices()).devices.length, 1);
  assert.equal((await first.getConfigSnapshot()).pairing?.state, "bridged");
  await first.dispose("end");
});

test("损坏恢复记录不能自动出站，也不能清除已经保存的设备授权", async () => {
  const app = installation();
  const first = await app.authorize();
  await first.dispose("exit");
  app.values.set(REMOTE_CONTROL_RECOVERY_CREDENTIAL_KEY, "{broken");
  const restarted = app.boot();
  await restarted.restorePairing(42);
  assert.equal(app.connections.length, 1);
  assert.equal((await restarted.refreshDevices()).devices.length, 1);
  assert.equal(app.warnings.length, 1);
  await restarted.dispose("end");
});

test("点击停止后立即退出，退出屏障必须等待停止意图落盘", async () => {
  const app = installation();
  const first = await app.authorize();
  let release!: () => void;
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  app.pauseRecoveryRead(async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const stopping = first.stopPairing("user-stop");
  let exited = false;
  const exiting = first.dispose("immediate-exit").then(() => {
    exited = true;
  });
  await reading;
  await Promise.resolve();
  assert.equal(exited, false);
  release();
  await Promise.all([stopping, exiting]);
  const restarted = app.boot();
  await restarted.restorePairing(42);
  assert.equal(app.connections.length, 1);
  await restarted.dispose("end");
});
