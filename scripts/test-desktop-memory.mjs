import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
// 与产品相同的 owner / 协议入口；只用合成夹具，不读取用户项目或调用模型。
const units = [
  "packages/shared/src/node/fileInvalidationWatcher.test.ts",
  "packages/services/src/model-provider/providerAccountStorage.watch.test.ts",
  "packages/services/src/git/gitReviewWorkspaceState.test.ts",
  "packages/services/src/git/gitReviewWorkspaceState.pressure.test.ts",
  "packages/desktop/scripts/window-host-recovery.test.mjs",
  "packages/desktop/src/main/startupWorkspace.test.ts",
  "packages/desktop/src/host/startupWarmup.test.ts",
  "packages/desktop/src/main/cronSchedulerResidency.test.ts",
  "packages/desktop/src/main/cronSchedulerDemandQuery.test.ts",
  "packages/desktop/src/scheduler/schedulerIdleExit.test.ts",
  "packages/desktop/scripts/scheduler-idle-lifecycle.test.ts",
  "packages/services/src/session/automationSchedulingDemand.test.ts",
  "packages/services/src/session/automationSelfDelete.test.ts",
  "packages/services/src/git-management/gitContextDiscovery.test.ts",
  "packages/services/src/lcode-agent/lcodeAgentBackgroundProcess.test.ts",
  "packages/services/src/lcode-agent/lcodeAgentIdleLifecycle.test.ts",
  "packages/services/src/lcode-agent/lcodeAgentMemoryBudget.test.ts",
  "packages/services/src/lcode-agent/lcodeProtocolClient.reverseResidency.test.ts",
  "packages/services/src/lcode-agent/lcodeProtocolClient.predictionTimeout.test.ts",
  "packages/services/src/lcode-agent/mcpStatusIsolation.test.ts",
  "packages/ui/src/lib/codeHighlightCache.test.ts",
  "packages/ui/src/lib/diffsWorkerPoolOwner.test.ts",
  "packages/ui/src/lib/previewDiffFileIdentity.test.ts",
  "packages/ui/src/store/taskQueryCacheBudget.test.ts",
  "packages/ui/src/store/lcodeSessionCacheReclamation.test.ts",
  "packages/ui/src/store/lcodeSessionStoreSelectors.test.ts",
  "packages/ui/src/terminal/sidePaneTerminalSessionRegistry.test.ts",
  "packages/services/src/terminal/terminalOutputFlow.test.ts",
  "packages/services/src/telemetry/credentialLoaders.test.ts",
  "packages/services/src/terminal/terminalRuntimeEnvironment.test.ts",
  "packages/ui/src/terminal/terminalOutputSubscription.test.ts",
  "packages/ui/src/lib/pdfRangeRequests.test.ts",
  "packages/ui/src/v4/conversationProjectionStore.workflowSync.test.ts",
  "packages/ui/src/v4/sessionDataLayer.budget.test.ts",
  "packages/ui/src/v4/windowControllerTaskListRegistry.budget.test.ts",
];
for (const args of [
  ["--import", "tsx", "--test", ...units],
  [
    "--test",
    "packages/desktop/scripts/preload-sandbox.test.mjs",
    "packages/desktop/scripts/scheduler-loading-boundary.test.mjs",
    "packages/desktop/scripts/main-loading-boundary.test.mjs",
    "packages/desktop/scripts/terminal-native-cleanup.test.mjs",
    "packages/desktop/scripts/desktop-runtime-benchmark.test.mjs",
    "packages/desktop/scripts/renderer-resource-surfaces.e2e.test.mjs",
    "packages/desktop/scripts/settings-loading.e2e.test.mjs",
    "packages/desktop/scripts/browser-resource-lifecycle.e2e.test.mjs",
    "packages/desktop/scripts/renderer-memory-lifecycle.e2e.test.mjs",
    "packages/desktop/scripts/workspace-query-cache-lifecycle.e2e.test.mjs",
  ],
]) {
  const code = await new Promise((done, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
      env: { ...process.env, TSX_TSCONFIG_PATH: resolve(root, "packages/ui/tsconfig.json") },
    });
    child.once("error", reject);
    child.once("exit", (value) => done(value ?? 1));
  });
  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}
