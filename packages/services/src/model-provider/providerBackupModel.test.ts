import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProviderBackupData,
  planProviderBackupMerge,
  providerBackupSnapshot,
} from "./providerBackupModel.js";
const data = (enabled: boolean, hasProvider = true) =>
  parseProviderBackupData({
    version: 1,
    accounts: [],
    personal: {
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: hasProvider
            ? [
                {
                  providerId: "fixture",
                  config: {
                    group: "standard-personal",
                    access: { type: "api-key", apiKey: "fixture" },
                  },
                },
              ]
            : [],
        },
        modelConfigRules: {
          providerModelRules: [{ providerId: "fixture", modelId: "model", config: { enabled } }],
          manualProviderModelRules: [],
        },
      },
    },
  });
const request = {
  id: "fixture",
  location: "local" as const,
  locationRevision: "fixture",
  mode: "merge" as const,
};
test("merge detects model-rule conflicts even when provider credentials are identical", () => {
  const current = data(false);
  const incoming = data(true);
  const snapshot = providerBackupSnapshot(incoming);
  const kept = planProviderBackupMerge(current, incoming, snapshot, request);
  assert.equal(
    kept.data.personal.config.modelConfigRules.providerModelRules[0]!.config.enabled,
    false,
  );
  const replaced = planProviderBackupMerge(current, incoming, snapshot, {
    ...request,
    overwriteConflicts: true,
  });
  assert.equal(
    replaced.data.personal.config.modelConfigRules.providerModelRules[0]!.config.enabled,
    true,
  );
  assert.equal(
    planProviderBackupMerge(incoming, incoming, snapshot, request).changes[0]!.action,
    "keep",
  );
});
test("full backup restores model-only inherited overrides without inventing provider roots", () => {
  const incoming = data(true, false);
  const empty = parseProviderBackupData({
    version: 1,
    accounts: [],
    personal: {
      schemaVersion: 1,
      config: {
        providerConfigRules: { providerRules: [] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      },
    },
  });
  const snapshot = providerBackupSnapshot(incoming);
  assert.ok(snapshot.items.some((item) => item.id === "fixture"));
  const merged = planProviderBackupMerge(empty, incoming, snapshot, request);
  assert.deepEqual(
    merged.data.personal.config.modelConfigRules,
    incoming.personal.config.modelConfigRules,
  );
  assert.equal(merged.data.personal.config.providerConfigRules.providerRules.length, 0);
});
