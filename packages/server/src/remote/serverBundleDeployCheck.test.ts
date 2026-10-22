import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { LocalFixtureRemoteBackend } from "./remoteMiseDeploy.fixture.js";
import { quotePosixShellArg } from "./posixShell.js";
import { checkServerBundleRequiredMarkers } from "./serverBundleDeployCheck.js";
import {
  assertRemoteBundleCapabilities,
  checkRemoteBundleCapabilities,
  PROJECT_NATIVE_AGENT_MARKERS,
} from "./remoteBundleCapabilityCheck.js";

const legacy = [
  "skill-sync",
  "mcp-sync",
  "plugin-sync",
  "__lcode_rpc_nested_uint8array_v1",
  "exportMarketplaceSourceArchive",
  "importMarketplaceSourceArchive",
];
const native = ["executeProjectNative", "onDynamicProjectNativeRequest", "respondProjectNative"];

test(
  "same-version remote servers missing any native routing interface require an update",
  { timeout: 20_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "lcode-server-capability-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const backend = new LocalFixtureRemoteBackend(join(root, "home"), {
      platform: "linux",
      arch: "x64",
    });
    const nodePath = join(root, "node").replaceAll("\\", "/");
    const serverPath = join(root, "server bundle.cjs").replaceAll("\\", "/");
    await mkdir(dirname(nodePath), { recursive: true });
    await writeFile(
      nodePath,
      `#!/bin/sh\nexec ${quotePosixShellArg(process.execPath.replaceAll("\\", "/"))} "$@"\n`,
    );
    await chmod(nodePath, 0o755);
    for (const missing of native) {
      await writeFile(
        serverPath,
        [...legacy, ...native.filter((marker) => marker !== missing)].join("\n"),
      );
      const decision = await checkServerBundleRequiredMarkers(backend, nodePath, serverPath);
      assert.equal(decision.shouldDeploy, true, missing);
      if (decision.shouldDeploy) assert.match(decision.reason, new RegExp(missing));
    }
    await writeFile(serverPath, [...legacy, ...native].join("\n"));
    assert.deepEqual(await checkServerBundleRequiredMarkers(backend, nodePath, serverPath), {
      shouldDeploy: false,
    });
    await writeFile(serverPath, "legacy Agent with same release version and SHA");
    assert.equal(
      (
        await checkRemoteBundleCapabilities(
          backend,
          nodePath,
          serverPath,
          PROJECT_NATIVE_AGENT_MARKERS,
        )
      ).shouldDeploy,
      true,
    );
    await assert.rejects(
      assertRemoteBundleCapabilities(backend, nodePath, serverPath, PROJECT_NATIVE_AGENT_MARKERS),
      /incompatible.*project\/native.*project\/routeNative/,
    );
    await writeFile(serverPath, PROJECT_NATIVE_AGENT_MARKERS.join("\n"));
    await assertRemoteBundleCapabilities(
      backend,
      nodePath,
      serverPath,
      PROJECT_NATIVE_AGENT_MARKERS,
    );
  },
);
