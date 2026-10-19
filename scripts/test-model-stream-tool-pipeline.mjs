import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = "apps/lcode-cli/packages/";
const tests = [
  "adapters/src/model/openai-compatible-empty-tools.test.ts",
  "adapters/src/model/cache-usage-wire.test.ts",
  "adapters/src/model/reasoning-history-normalization.test.ts",
  "adapters/src/storage/session-store/parts-batch.test.ts",
  "adapters/src/storage/session-store/store-transactions.test.ts",
  "adapters/src/storage/session-store/transcript-snapshot.test.ts",
  "adapters/src/storage/session-store/transcript-window.test.ts",
  "adapters/src/storage/session-store/transcript-window-budget.test.ts",
  "adapters/src/storage/session-store/transcript-window-branch.test.ts",
  "core/src/runtime/methods/assistant-content-persistence.test.ts",
  "core/src/runtime/methods/streaming-tool-coordinator.test.ts",
  "core/src/runtime/methods/streaming-tool-execution.test.ts",
  "core/src/tool/scheduler.test.ts",
  "core/src/tool/executor/concurrency.test.ts",
  "core/src/tool/executor/operation-admission.test.ts",
  "core/src/tool/executor/call-runner.test.ts",
  "core/src/tool/executor/workflow-model-approval.test.ts",
  "bootstrap/src/lcode-protocol-v4/product-projection-reasoning.test.ts",
  "bootstrap/src/lcode-protocol-v4/product-projection-stop-feedback.test.ts",
  "bootstrap/src/lcode-protocol-v4/product-projection-tool-pipeline.test.ts",
  "bootstrap/src/lcode-protocol-v4/transcript-hydration-reasoning.test.ts",
].map((path) => cli + path);
tests.push(
  "scripts/agent-model-stream-patch.test.mjs",
  "scripts/workspace-patch-notices.test.mjs",
  "scripts/notice-artifacts.test.mjs",
);
if (process.argv.includes("--browser"))
  tests.push(
    "packages/web/test/model-stream-tool-pipeline.test.mjs",
    "packages/web/test/conversation-timeline-depth.test.mjs",
  );
const child = spawn(process.execPath, ["--import", "tsx", "--test", ...tests], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  stdio: "inherit",
  windowsHide: true,
});
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
