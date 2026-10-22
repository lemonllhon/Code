import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NodePersonalProviderConfigRepository,
  decodeProviderConfigFile,
} from "@lcode/provider-node";
import { ProviderAccounts, getProviderAccountBackupPort } from "./providerAccounts.js";
import { createProviderBackupSource } from "./providerBackupSource.js";
test("real Personal repository restores full and selected providers with a large credential pool", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "provider-backup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function profile(name: string) {
    const profileDir = join(root, name);
    const personalFilePath = join(profileDir, "personal.json");
    const repository = new NodePersonalProviderConfigRepository({
      filePath: personalFilePath,
      pollingIntervalMs: false,
    });
    const secrets = new Map<string, string>();
    const credentials = {
      load: async (key: string) => secrets.get(key) ?? null,
      save: async (key: string, value: string) => {
        secrets.set(key, value);
      },
      delete: async (key: string) => {
        secrets.delete(key);
      },
    };
    const accounts = new ProviderAccounts({
      credentials,
      lockPath: join(profileDir, "accounts"),
      channels: [],
    });
    t.after(async () => {
      repository.dispose();
      await accounts.dispose();
    });
    const backup = createProviderBackupSource({
      profileDir,
      personalFilePath,
      personalRepository: repository,
      accounts: getProviderAccountBackupPort(accounts),
      credentials,
      refresh: async () => {},
    });
    await backup.ready;
    return { repository, port: backup.port };
  }
  const old = await profile("old");
  const fresh = await profile("new");
  const keys = Array.from({ length: 100_001 }, (_, i) => ({
    id: `fixture-${i}`,
    apiKey: `fixture-key-${i}`,
    enabled: i % 2 === 0,
  }));
  await old.repository.update(() =>
    decodeProviderConfigFile({
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "personal-fixture",
              providerName: "Fixture",
              config: {
                group: "standard-personal",
                access: { type: "api-key", apiKeys: keys },
                api: { type: "openai-chat-completions", baseUrl: "https://fixture.invalid/v1" },
              },
            },
          ],
        },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      },
    }),
  );
  const snapshot = await old.port.capture();
  const request = {
    id: "fixture",
    location: "local" as const,
    locationRevision: "fixture",
    mode: "merge" as const,
  };
  const preview = await fresh.port.inspect(snapshot, request);
  await fresh.port.restore(snapshot, request, preview.revision, "restore");
  assert.deepEqual((await fresh.port.capture()).data, snapshot.data);
  const second = await fresh.port.inspect(snapshot, request);
  assert.equal(second.changes.length, 1);
  await fresh.repository.update((current) => ({ ...current, providerOrder: ["changed"] }));
  await assert.rejects(fresh.port.restore(snapshot, request, second.revision, "stale"), /changed/);
});
