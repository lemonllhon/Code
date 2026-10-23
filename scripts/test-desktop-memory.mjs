import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
// 与产品相同的 owner / 协议入口；只用合成夹具，不读取用户项目或调用模型。
const units = [
  "packages/desktop/scripts/window-host-recovery.test.mjs",
  "packages/desktop/src/main/startupWorkspace.test.ts",
  "packages/desktop/src/host/startupWarmup.test.ts",
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
];
for (const args of [
  ["--import", "tsx", "--test", ...units],
  [
    "--test",
    "packages/desktop/scripts/scheduler-loading-boundary.test.mjs",
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
