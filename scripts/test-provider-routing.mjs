import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const groups = [
  [
    "packages/provider/test",
    /^(?:routing-.*|model-membership.*|model-interaction-protocol|provider-api-keys|provider-network|rate-limit)\.test\.ts$/u,
  ],
  [
    "packages/services/src/model-provider",
    /^(?:providerAccounts?.*|providerProxyPersistence|providerRuntimeLargeKeys|providerSettingsLargeKeys)\.test\.ts$/u,
  ],
  ["apps/lcode-cli/packages/adapters/src/model", /^api-key-.*\.test\.ts$/u],
  ["apps/lcode-cli/packages/bootstrap/src", /^model-config-routing\.test\.ts$/u],
  ["packages/ui/src/settings/model-provider-section", /^providerApiKey(?:s|Import)\.test\.ts$/u],
  [
    "packages/provider-node/src/provider-auth/native",
    /^(?:routing-single-attempt|copilot-auto.*|copilot-manual|google-refresh)\.test\.ts$/u,
  ],
  [
    "packages/services/src/lcode-agent",
    /^(?:providerConnectivityStartup|mcpStatusIsolation)\.test\.ts$/u,
  ],
  ["apps/lcode-cli/packages/adapters/src/mcp", /^settings-session-isolation\.test\.ts$/u],
  ["packages/services/src/plugins", /^pluginManagementService\.test\.ts$/u],
  [
    "packages/provider-node/src/provider-auth/plugins",
    /^(?:authorization-progress|single-attempt.*|backport-(?:.*-)?fixtures|zcode-start-fixtures|transport-(?:children|close))\.test\.ts$/u,
  ],
  ["packages/provider-node/src", /^process-tree\.test\.ts$/u],
  [
    "packages/provider-node/src/provider-auth/native",
    /^(?:authorization-diagnostics|claude-routing|claude-relay-lifecycle)\.test\.ts$/u,
  ],
  [
    "apps/lcode-cli/packages/bootstrap/src/lcode-protocol",
    /^(?:provider-runtime-headers|connectivity-network|session-resume-transaction)\.test\.ts$/u,
  ],
];
const files = process.argv.includes("--ui")
  ? [
      "packages/web/test/provider-routing.test.mjs",
      "packages/web/test/provider-authorization-diagnostics.test.mjs",
      "packages/web/test/routing-recovery-error.test.mjs",
      "packages/web/test/routing-retry-sessions.test.mjs",
    ]
  : (
      await Promise.all(
        groups.map(async ([directory, pattern]) =>
          (await readdir(new URL(`../${directory}/`, import.meta.url)))
            .filter((name) => pattern.test(name))
            .map((name) => `${directory}/${name}`),
        ),
      )
    )
      .flat()
      .concat(
        "packages/provider-node/src/provider-auth/plugins/vendor-compatibility.test.mjs",
        "packages/provider-node/src/provider-auth/plugins/vendor-backports-20261022.test.mjs",
        "packages/provider-node/src/provider-auth/plugins/vendor-followup.test.mjs",
        "packages/provider-node/src/provider-auth/plugins/vendor-stream-followup.test.mjs",
        "apps/lcode-cli/packages/adapters/src/model/content-refusal.test.ts",
        "apps/lcode-cli/packages/core/src/errors/error-routing-attribution.test.ts",
        "apps/lcode-cli/packages/bootstrap/src/app/routing-session-retry.test.ts",
        "apps/lcode-cli/packages/bootstrap/src/lcode-protocol-v4/product-projection-retry-isolation.test.ts",
        "apps/lcode-cli/packages/bootstrap/src/lcode-protocol-v4/product-projection-stop-feedback.test.ts",
        "apps/lcode-cli/packages/bootstrap/src/lcode-protocol-v4/model-output-statistics.test.ts",
        "apps/lcode-cli/packages/bootstrap/src/lcode-protocol-v4/v4-gateway-contract.test.ts",
        "apps/lcode-cli/packages/bootstrap/src/lcode-protocol-v4/commands/handlers/queue-handoff.test.ts",
        "apps/lcode-cli/packages/core/src/runtime/methods/streaming-tool-coordinator.test.ts",
        "packages/shared/src/lcode-protocol-v4/routing-recovery-error.test.ts",
      )
      .sort();
const child = spawn(
  process.execPath,
  ["--import", "tsx", "--test", "--test-concurrency=4", ...files],
  { cwd: root, windowsHide: true, stdio: "inherit" },
);
child.once("error", (error) => {
  throw error;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
