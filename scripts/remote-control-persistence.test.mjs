import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

// 真正的进程重建与加密文件 IO，避免内存凭据桩掩盖退出时尚未提交的恢复记录。
const childSource = `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRemoteControlController } from './src/main/desktopRemoteControlController.ts';
import { createCredentialService } from '@lcode/services/node';
let params, delegate, connections = 0;
const warnings = [];
const controller = createRemoteControlController({
  credentialService: createCredentialService(),
  logger: { info() {}, error() {}, warn(message) { warnings.push(message); } },
  broadcast() {},
  attachLocalWorkspaceSessionHost() { throw Error('unused'); },
  attachRemoteWorkspaceSessionHost() { throw Error('unused'); },
  createTunnelSession(p, d) {
    params = p; delegate = d; connections++;
    return { roomId: p.roomId, stopRoom() {}, isRunning: () => true, isBridged: () => false };
  },
});
const phase = process.env.RECOVERY_TEST_PHASE;
if (phase === 'authorize') {
  await controller.setConfig({ enabled: true });
  assert.equal((await controller.startPairing({ target: { kind: 'local', windowId: 1 } })).success, true);
  delegate.onRoomReady({ type: 'room.ready', proto: 1, roomId: params.roomId,
    expiresAt: Date.now() + 300000, multiDevice: true, persistentRoom: true });
  delegate.onPairingAccepted({ type: 'pairing.accepted', requestId: 'test', roomId: params.roomId,
    deviceId: 'test-browser', deviceName: 'Browser', credHash: 'test-hash', grantedAt: Date.now() });
} else {
  await controller.restorePairing(42);
  if (phase === 'after-stop') assert.equal(connections, 0);
  else {
    assert.equal(connections, 1);
    assert.equal(params.devices[0].deviceId, 'test-browser');
    await controller.stopPairing('manual-stop');
  }
}
await controller.dispose('normal-exit');
assert.deepEqual(warnings, []);
const digest = value => createHash('sha256').update(value).digest('hex');
console.log(JSON.stringify({ connections, room: params && digest(params.roomId),
  identity: params && digest(params.hostToken) }));
`;

test(
  "真实加密文件：重启恢复原身份，手动停止后的第三个进程不再出站",
  { timeout: 60000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "lcode-remote-restart-"));
    t.after(async () => {
      const relativePath = relative(resolve(tmpdir()), resolve(directory));
      assert.ok(relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath));
      assert.ok(relativePath.startsWith("lcode-remote-restart-"));
      await rm(directory, { recursive: true, force: true });
    });
    const results = [];
    for (const phase of ["authorize", "restart-and-stop", "after-stop"]) {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", childSource],
        {
          cwd: resolve(import.meta.dirname, "../packages/desktop"),
          windowsHide: true,
          env: { ...process.env, LCODE_DATA_BASE_DIR: directory, RECOVERY_TEST_PHASE: phase },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const code = await new Promise((resolveExit, reject) => {
        child.once("error", reject);
        child.once("exit", resolveExit);
      });
      assert.equal(code, 0, phase + ": " + stderr);
      results.push(JSON.parse(stdout.trim().split("\n").at(-1)));
    }
    assert.equal(results[0].room, results[1].room);
    assert.equal(results[0].identity, results[1].identity);
    assert.equal(results[2].connections, 0);
    const disk = await readFile(join(directory, ".lcode", "v2", "credentials.json"), "utf8");
    assert.ok(!disk.includes("hostToken") && !disk.includes("listening"));
  },
);
