import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingService } from "./settingService.js";

test("device profiles persist without folders, migrate once, reject secrets, and retain CAS/replay across owners", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-device-profile-"));
  const previous = process.env.LCODE_DESKTOP_HOME_DIR;
  process.env.LCODE_DESKTOP_HOME_DIR = directory;
  try {
    const first = createSettingService(),
      second = createSettingService();
    await first.update({
      lastWorkspaceSession: [
        {
          kind: "remote",
          workspacePath: "/fixture/app",
          target: {
            kind: "ssh",
            host: "example.invalid",
            username: "fixture",
            useProxy: true,
            proxyProfileId: "fixture-proxy",
            assetInstallMode: "remote-download",
            passwordCredentialKey: "fixture-reference",
          },
          lastOpenedAt: 1,
          lastConnectionStatus: "connected",
        },
      ],
    });
    const migrated = (await first.get()).remoteDevices!.devices[0]!;
    assert.equal(migrated.target.kind, "ssh");
    assert.deepEqual((await second.get()).remoteDevices!.devices, [migrated]);
    const create = {
      type: "save" as const,
      operationId: "create-zero-project-device",
      deviceId: "zero",
      expectedRevision: null,
      name: "WSL fixture",
      target: { kind: "wsl" as const, distro: "Fixture", user: "fixture" },
    };
    const saved = await first.mutateRemoteDevice!(create);
    assert.equal(saved.status, "applied");
    assert.equal((await createSettingService().get()).remoteDevices!.devices.length, 2);
    assert.deepEqual(await second.mutateRemoteDevice!(create), saved);
    const duplicate = await second.mutateRemoteDevice!({
      ...create,
      operationId: "duplicate-device",
      deviceId: "duplicate",
    });
    assert.equal(duplicate.status, "conflict");
    assert.equal(duplicate.device?.id, "zero");
    await assert.rejects(second.mutateRemoteDevice!({ ...create, name: "different" }), /reused/);
    const edits = await Promise.all(
      [first, second].map((owner, index) =>
        owner.mutateRemoteDevice!({
          ...create,
          operationId: `edit-${index}`,
          expectedRevision: 1,
          name: `edited-${index}`,
        }),
      ),
    );
    assert.deepEqual(edits.map((result) => result.status).sort(), ["applied", "conflict"]);
    const retargeted = await first.mutateRemoteDevice!({
      ...create,
      operationId: "retarget",
      expectedRevision: 2,
      target: { ...create.target, user: "another-user" },
    });
    assert.equal(retargeted.status, "conflict");
    assert.equal(
      retargeted.device?.target.kind === "wsl" && retargeted.device.target.user,
      "fixture",
    );
    await first.mutateRemoteDevice!({
      type: "remove",
      operationId: "remove-migrated",
      deviceId: migrated.id,
      expectedRevision: 1,
    });
    const reloaded = await createSettingService().get();
    assert.equal(reloaded.remoteDevices!.devices.length, 1);
    assert.equal(
      reloaded.lastWorkspaceSession!.length,
      1,
      "removing configuration retains project history",
    );
    await assert.rejects(
      first.update({ remoteDevices: { version: 1, devices: [] } }),
      /remote device command/,
    );
    await assert.rejects(
      first.mutateRemoteDevice!({
        ...create,
        operationId: "secret",
        deviceId: "secret",
        target: {
          kind: "ssh",
          host: "example.invalid",
          username: "fixture",
          password: "fixture-must-not-persist",
        },
      } as never),
    );
    assert.equal(
      (await readFile(join(directory, ".lcode", "v2", "setting.json"), "utf8")).includes(
        "fixture-must-not-persist",
      ),
      false,
    );
  } finally {
    if (previous === undefined) delete process.env.LCODE_DESKTOP_HOME_DIR;
    else process.env.LCODE_DESKTOP_HOME_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
