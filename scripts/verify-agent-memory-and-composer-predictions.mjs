import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
async function testsIn(directory, pattern) {
  const entries = await readdir(resolve(root, directory), { withFileTypes: true });
  const groups = await Promise.all(
    entries.map(async (entry) => {
      const path = `${directory}/${entry.name}`;
      return entry.isDirectory() ? testsIn(path, pattern) : pattern.test(entry.name) ? [path] : [];
    }),
  );
  return groups.flat();
}

async function run(label, args) {
  process.stdout.write(`\n${label}\n`);
  const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit", windowsHide: true });
  const code = await new Promise((yes, no) => {
    child.once("error", no);
    child.once("exit", (exitCode, signal) => yes(signal ? 1 : (exitCode ?? 1)));
  });
  if (code !== 0) throw new Error(`${label} failed (exit ${code})`);
}

const cli = [
  ...new Set(
    (
      await Promise.all([
        testsIn("apps/lcode-cli/packages/core/src/memory", /\.test\.ts$/u),
        testsIn(
          "apps/lcode-cli/packages/core/src/runtime/helpers",
          /^project-memory.*\.test\.ts$/u,
        ),
        testsIn("apps/lcode-cli/packages/adapters/src/fs", /memory.*\.test\.ts$/u),
        testsIn("apps/lcode-cli/packages/core/src/session-context", /history.*\.test\.ts$/u),
        testsIn(
          "apps/lcode-cli/packages/adapters/src/storage/session-store",
          /^(?:transcript-.*|history-discovery|memory-evidence.*)\.test\.ts$/u,
        ),
        testsIn("apps/lcode-cli/packages/bootstrap/src/app", /memory.*\.test\.ts$/u),
        testsIn("apps/lcode-cli/packages/core/src/tool/handlers", /memory.*\.test\.ts$/u),
      ])
    )
      .flat()
      .concat([
        "apps/lcode-cli/packages/core/src/runtime/methods/turn-complete-memory.test.ts",
        "apps/lcode-cli/packages/core/src/runtime/methods/turn-memory-recall.test.ts",
        "apps/lcode-cli/packages/core/src/runtime/methods/context-project-memory.test.ts",
        "apps/lcode-cli/packages/core/src/runtime/methods/memory-effect-observation.test.ts",
        "apps/lcode-cli/packages/core/src/tool/executor/memory-maintenance.test.ts",
        "apps/lcode-cli/packages/core/src/runtime/methods/composer-prediction.test.ts",
        "apps/lcode-cli/packages/core/src/runtime/methods/workspace-task-name.test.ts",
        "apps/lcode-cli/packages/core/src/runtime/methods/goal-evidence-events.test.ts",
        "apps/lcode-cli/packages/bootstrap/src/lcode-protocol/composer-prediction-binding.test.ts",
        "apps/lcode-cli/packages/adapters/src/config/data-base-paths.test.ts",
        "apps/lcode-cli/packages/adapters/src/model/runner-runtime-stream.test.ts",
        "apps/lcode-cli/packages/adapters/src/model/runner-routing-feedback.test.ts",
        "apps/lcode-cli/packages/adapters/src/model/model-execution-api-key-failover.test.ts",
        "packages/provider/test/routing-bound-busy.test.ts",
      ]),
  ),
].sort();

try {
  await run("Agent memory, history and Runtime integration", ["--import", "tsx", "--test", ...cli]);
  const tsx = relative(root, fileURLToPath(import.meta.resolve("tsx/cli")));
  await run("UI settings, protocol and delivery provenance", [
    tsx,
    "--tsconfig",
    "packages/ui/tsconfig.json",
    "--test",
    "packages/ui/src/settings/MemorySettingsSection.test.tsx",
    "packages/shared/src/composer-predictions.test.ts",
    "packages/shared/src/sessionRecallSettings.test.ts",
    "packages/ui/src/v4/conversationProjectionStore.workflowSync.test.ts",
    "packages/services/src/lcode-agent/lcodeProtocolClient.predictionTimeout.test.ts",
    "packages/rpc/test/proxyCancellation.test.ts",
    "packages/rpc/test/channelServer.test.ts",
  ]);
  await run("Browser keyboard, IME, recovery and mobile regression", [
    "--test",
    "--test-concurrency=1",
    "packages/web/test/composer-prediction.test.mjs",
    "packages/web/test/memory-settings.test.mjs",
  ]);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
