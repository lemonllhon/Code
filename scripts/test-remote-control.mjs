// tag 构建与本地使用同一组远控回归；UI 源码测试通过当前 tsconfig 解析别名。
import { spawn } from "node:child_process";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const files = [
  "scripts/remote-control-persistence.test.mjs",
  "packages/rpc/test/channelServer.test.ts",
  "packages/rpc/test/proxyCancellation.test.ts",
  "packages/shared/src/remoteControlBridgeFrame.test.ts",
  "packages/shared/src/sshProxyBoundary.test.ts",
  "packages/desktop/src/main/desktopRemoteControlController.test.ts",
  "packages/desktop/src/main/desktopRemoteControlRestart.test.ts",
  "packages/desktop/src/main/desktopRemoteControlTunnel.test.ts",
  "packages/desktop/src/main/desktopRemoteControlFramePump.test.ts",
  "packages/desktop/src/host/windowWorkspaceAttachmentService.test.ts",
  "packages/desktop/src/host/windowWorkspaceReconnectOwner.test.ts",
  "packages/desktop/src/host/windowRemoteConnectionRegistry.test.ts",
  "packages/desktop/src/host/hostLifecycle.test.ts",
  "packages/desktop/src/host/remoteWorkspaceServiceCollection.projectNative.test.ts",
  "packages/desktop/src/host/remoteWorkspaceServiceCollection.runtimeEnvironment.test.ts",
  "packages/desktop/src/host/remoteWorkspaceServiceCollection.memorySettings.test.ts",
  "packages/services/src/lcode-agent/projectNativeBridge.test.ts",
  "packages/services/src/serviceResourceLifecycle.test.ts",
  "packages/services/src/nodeResourceDisposal.test.ts",
  "packages/services/src/model-provider/providerServiceShutdown.test.ts",
  "packages/services/src/git/gitReviewWorkspaceState.test.ts",
  "packages/services/src/cua-permission-broker/cuaPipSessionService.test.ts",
  "packages/ui/src/hooks/groupedWorkspaceService.test.ts",
  "packages/ui/src/hooks/remoteBrowserWorkspaceCatalog.test.ts",
  "packages/ui/src/hooks/windowWorkspaceReconnect.test.ts",
  "packages/ui/src/lib/remoteWorkspaceRemoval.test.ts",
  "packages/ui/src/settings/MobileRemoteControlPanel.test.tsx",
  "packages/ui/src/settings/RemoteControlSettingsSection.test.tsx",
  "packages/ui/src/store/remoteBrowserNavigationStore.test.ts",
  "packages/ui/src/hooks/remoteBrowserNavigationRestore.test.ts",
  "packages/web/test/pairingCredentialStore.test.mjs",
  "packages/web/test/pairingFrames.test.mjs",
];
const code = await new Promise((resolveExit, reject) => {
  const child = spawn(process.execPath, ["--import", "tsx", "--test", ...files], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, TSX_TSCONFIG_PATH: resolve(root, "packages/ui/tsconfig.json") },
  });
  child.once("error", reject);
  child.once("exit", (value) => resolveExit(value ?? 1));
});
process.exitCode = code;
