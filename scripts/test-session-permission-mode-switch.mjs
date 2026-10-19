import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = "apps/lcode-cli/packages/";
const tests = [
  "adapters/src/storage/session-store/permission-mode-switch.test.ts",
  "core/src/runtime/permission-mode-switch.test.ts",
  "core/src/tool/executor/permission-mode-recheck.test.ts",
  "core/src/tool/executor/permission-responder-race.test.ts",
  "core/src/tool/executor/call-runner.test.ts",
  "core/src/tool/executor/concurrency.test.ts",
  "core/src/tool/executor/operation-admission.test.ts",
  "core/src/tool/executor/workflow-model-approval.test.ts",
  "bootstrap/src/lcode-protocol-v4/permission-mode-switch.test.ts",
  "bootstrap/src/lcode-protocol/interaction-response-refactor.test.ts",
].map((path) => cli + path);

function run(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      stdio: "inherit",
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}
let code = await run(["--import", "tsx", "--test", ...tests]);
if (!code)
  code = await run(
    ["--import", "tsx", "--test", "packages/ui/src/v4/composer/composerPermissionGrant.test.ts"],
    {
      TSX_TSCONFIG_PATH: "packages/ui/tsconfig.json",
    },
  );
if (!code && process.argv.includes("--browser"))
  code = await run([
    "--test",
    "--test-concurrency=1",
    "packages/web/test/permission-mode-switch.test.mjs",
    "packages/web/test/conversation-send.test.mjs",
  ]);
process.exitCode = code;
