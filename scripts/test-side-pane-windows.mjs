import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const child = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "--test",
    "packages/ui/src/app-shell/SidePaneToolNavigation.test.tsx",
    "packages/ui/src/lib/sidePaneToolWindow.test.ts",
    "packages/ui/src/lib/sidePaneGitOwnership.test.ts",
    "packages/ui/src/store/commitReviewPane.test.ts",
    "packages/ui/src/store/commitReviewNavigationStore.test.ts",
    "packages/ui/src/hooks/useDetachedBrowserScreenshotRequest.test.ts",
    "packages/desktop/scripts/tool-windows.e2e.test.mjs",
    "packages/desktop/scripts/tool-window-browser.e2e.test.mjs",
    "packages/desktop/src/main/browserView/browserScreenshotSurfaceIdentity.test.ts",
    "packages/web/test/side-pane-recovery.test.mjs",
  ],
  {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, TSX_TSCONFIG_PATH: "packages/ui/tsconfig.json" },
  },
);
child.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
