import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NodePersonalProviderConfigRepository,
  decodeProviderConfigFile,
} from "@lcode/provider-node";
import type { PersonalProviderConfigRepository } from "@lcode/provider";
import { ProxyChannel } from "@lcode/rpc";
import { ProviderAccounts, getProviderAccountBackupPort } from "./providerAccounts.js";
import { createProviderBackupSource } from "./providerBackupSource.js";
import { createProviderAccountContext } from "./providerAccountContext.js";
const providerConfig = (apiKey: string) =>
  decodeProviderConfigFile({
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: "fixture-provider",
            config: { group: "standard-personal", access: { type: "api-key", apiKey } },
          },
        ],
      },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  });
test("partial provider restore preserves unrelated raw grants; interrupted transaction recovers before access", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "provider-transaction-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const personalFilePath = join(directory, "personal.json");
  const real = new NodePersonalProviderConfigRepository({
    filePath: personalFilePath,
    pollingIntervalMs: false,
  });
  t.after(() => real.dispose());
  let failWrites = 0;
  const repository: PersonalProviderConfigRepository = {
    read: () => real.read(),
    onDidChange: (listener) => real.onDidChange(listener),
    update: (transform) => {
      if (failWrites > 0) {
        failWrites--;
        return Promise.reject(new Error("fixture write failure"));
      }
      return real.update(transform);
    },
  };
  const values = new Map<string, string>();
  const credentials = {
    load: async (key: string) => values.get(key) ?? null,
    save: async (key: string, value: string) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
  };
  const accounts = new ProviderAccounts({
    credentials,
    lockPath: join(directory, "accounts"),
    channels: [],
  });
  t.after(() => accounts.dispose());
  const port = getProviderAccountBackupPort(accounts);
  await port.replaceBackupAccounts([
    {
      connectionId: "f91b3aa4-9f35-4d46-a4d0-39fad19189de",
      channelId: "unknown-bound-driver",
      displayName: "Bound account",
      enabled: true,
      generation: 1,
      grant: { type: "oauth", deviceBoundSecret: "fixture-private" },
      models: [],
    },
  ]);
  await real.update(() => providerConfig("original-key"));
  const options = {
    profileDir: directory,
    personalFilePath,
    personalRepository: repository,
    accounts: port,
    credentials,
    refresh: async () => {},
  };
  const source = createProviderBackupSource(options);
  await source.ready;
  const before = await port.readBackupTransactionAccounts();
  const snapshot = await source.port.capture({ providerIds: ["fixture-provider"] });
  const modified = structuredClone(snapshot);
  const data = modified.data as {
    personal: {
      config: {
        providerConfigRules: { providerRules: { config: { access: { apiKey: string } } }[] };
      };
    };
  };
  data.personal.config.providerConfigRules.providerRules[0]!.config.access.apiKey = "restored-key";
  const request = {
    id: "fixture",
    location: "local" as const,
    locationRevision: "fixture",
    mode: "replace" as const,
    selection: { providerIds: ["fixture-provider"] },
  };
  const preview = await source.port.inspect(modified, request);
  await source.port.restore(modified, request, preview.revision, "partial");
  assert.deepEqual(await port.readBackupTransactionAccounts(), before);
  const channel = ProxyChannel.fromService(accounts);
  assert.throws(() => channel.call(undefined, "exportBackupAccounts", []), /Method not found/);
  assert.throws(
    () => channel.call(undefined, "readBackupTransactionAccounts", []),
    /Method not found/,
  );
  const current = await source.port.capture();
  const plan = await source.port.inspect(snapshot, request);
  failWrites = 2;
  await assert.rejects(
    source.port.restore(snapshot, request, plan.revision, "crash"),
    /rollback needs repair/,
  );
  await assert.rejects(real.read(), /requires recovery/);
  const restarted = createProviderBackupSource(options);
  await restarted.ready;
  assert.deepEqual((await restarted.port.capture()).data, current.data);
  assert.deepEqual(await port.readBackupTransactionAccounts(), before);
});
test("restore epoch rejects a late refresh even when the numeric generation was reused", async () => {
  const id = "f91b3aa4-9f35-4d46-a4d0-39fad19189de";
  const account = {
    connectionId: id,
    channelId: "codex",
    displayName: "Fixture",
    enabled: true,
    generation: 1,
    grant: { type: "oauth" as const, access: "old" },
    models: [],
  };
  let current = { ...account, restoreEpoch: undefined as string | undefined };
  const context = createProviderAccountContext(
    {
      read: async () => [current],
      mutate: async (update) => {
        const all = [current];
        update(all);
        current = all[0]!;
      },
    },
    account,
  );
  const lateCommit = context.captureRefreshCommit!();
  current = {
    ...current,
    restoreEpoch: "692bd141-711e-4079-acb8-b2ae5e67b279",
    grant: { type: "oauth", access: "restored" },
  };
  await assert.rejects(lateCommit({ type: "oauth", access: "stale" }), /Stale/);
  assert.equal(current.grant.access, "restored");
});
