import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { NodePersonalProviderConfigRepository } from "../packages/provider-node/src/personal-provider-config-repository.ts";
import { encodeProviderConfigFile } from "../packages/provider-node/src/provider-config-file-codec.ts";
import { createProviderProvisioningTarget } from "../packages/services/src/model-provider/providerProvisioningTarget.ts";
import { createProviderProvisioningSource } from "../packages/services/src/model-provider/providerProvisioningSource.ts";
import { createRemoteProviderProvisioningExecutor } from "../packages/desktop/src/host/remoteProviderProvisioningService.ts";

const sensitive =
  "fixture-secret https://private.example.invalid/?token=fixture-token /home/private/account.json\npassword=fixture";
const personalConfig = {
  providerConfigRules: { providerRules: [] },
  modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
};
const envelope = () => ({
  schemaVersion: 1,
  syncId: "fixture-sync",
  personalConfig: structuredClone(personalConfig),
  accountSettings: { providerFamilyDomain: null, providerFamilyConnectionSelections: {} },
  credentials: [{ scope: "oauth-session", key: "oauth:zai:access_token", value: "fixture-value" }],
});
function noSecrets(value) {
  const output = JSON.stringify(value);
  for (const token of [
    "fixture-secret",
    "fixture-token",
    "private.example",
    "/home/private",
    "password=",
  ])
    assert.ok(!output.includes(token), output);
}

async function fixture(t, fault) {
  const root = await mkdtemp(join(tmpdir(), "remote-provider-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const personalFile = join(root, "provider_config.json");
  const stateFile = join(root, "provisioning.json");
  await writeFile(personalFile, JSON.stringify({ schemaVersion: 1, config: personalConfig }));
  const repository = new NodePersonalProviderConfigRepository({
    filePath: personalFile,
    pollingIntervalMs: false,
  });
  t.after(() => repository.dispose());
  const initial = encodeProviderConfigFile(await repository.read());
  let failed = false;
  function fail(stage) {
    if (!failed && fault === stage) {
      failed = true;
      throw Object.assign(new Error(sensitive), { code: "EACCES" });
    }
  }
  const credentials = new Map();
  let settings = {};
  const target = createProviderProvisioningTarget({
    personalRepository: {
      read: async () => {
        fail("remote-before-state");
        return repository.read();
      },
      update: async (transform) => {
        fail("remote-personal");
        return repository.update(transform);
      },
    },
    personalConfigFilePath: personalFile,
    stateFilePath: stateFile,
    settingService: {
      get: async () => structuredClone(settings),
      update: async (patch) => {
        fail("remote-settings");
        settings = { ...settings, ...patch };
      },
    },
    credentialService: {
      load: async (key) => credentials.get(key) ?? null,
      save: async (key, value) => {
        fail("remote-credentials");
        credentials.set(key, value);
      },
      delete: async (key) => credentials.delete(key),
    },
    accountProviderSource: {
      refresh: async (reason) => {
        if (fault === "rollback" && reason === "provider-provisioning-rollback")
          throw Object.assign(new Error(sensitive), { code: "EPERM" });
        fail("remote-account");
      },
    },
    providerRuntime: {
      start: async () => {
        if (fault === "builtin")
          throw Object.assign(new Error(sensitive), {
            code: "LCODE_BUILTIN_CONFIG_UNAVAILABLE",
            availability: { bundled: "missing", active: "missing" },
          });
        fail("remote-runtime");
      },
      registryService: {
        refresh: async (reason) => {
          if (fault === "rollback" && reason === "provider-provisioning")
            throw Object.assign(new Error(sensitive), { code: "LCODE_PROVISIONING_INVALID" });
          fail("remote-registry");
          if (fault === "remote-state-write" && reason === "provider-provisioning")
            await mkdir(stateFile);
          return { sourceRevisions: { config: "fixture-revision" } };
        },
        validateSelection: () => ({ ok: fault !== "remote-default" }),
      },
    },
  });
  return { root, target, repository, initial, credentials };
}

for (const stage of [
  "remote-runtime",
  "remote-before-state",
  "remote-settings",
  "remote-credentials",
  "remote-personal",
  "remote-account",
  "remote-registry",
  "remote-state-write",
  "remote-default",
]) {
  test(`远端 ${stage} 失败返回准确阶段并按原事务回滚，原始错误不跨 RPC`, async (t) => {
    const { target, repository, initial, credentials } = await fixture(t, stage);
    const input = envelope();
    if (stage === "remote-default")
      input.personalConfig.defaultModelSelection = { providerId: "fixture", modelId: "fixture" };
    const result = await target.apply(input);
    assert.equal(result.status, "failed");
    assert.equal(result.failure.stage, stage);
    if (stage === "remote-default") assert.equal(result.failure.code, "default-unavailable");
    else if (stage !== "remote-state-write") assert.equal(result.failure.systemCode, "EACCES");
    assert.equal(result.rolledBack, true);
    assert.deepEqual(encodeProviderConfigFile(await repository.read()), initial);
    assert.equal(credentials.size, 0);
    noSecrets(result);
  });
}

test("远端 Built-in 缺失在 Runtime 阶段提供安全候选状态", async (t) => {
  const { target } = await fixture(t, "builtin");
  const result = await target.apply(envelope());
  assert.deepEqual(result.failure, {
    stage: "remote-runtime",
    code: "builtin-unavailable",
    availability: { bundled: "missing", active: "missing" },
  });
  noSecrets(result);
});

test("回滚失败保留原始失败阶段及独立回滚权限原因", async (t) => {
  const { target } = await fixture(t, "rollback");
  const result = await target.apply(envelope());
  assert.equal(result.status, "rollback_failed");
  assert.equal(result.failure.stage, "remote-registry");
  assert.equal(result.rollbackFailure.stage, "remote-rollback");
  assert.equal(result.rollbackFailure.systemCode, "EPERM");
  noSecrets(result);
});

test("同步成功与重复 syncId 仍然幂等", async (t) => {
  const { target } = await fixture(t);
  assert.equal((await target.apply(envelope())).status, "applied");
  assert.equal((await target.apply(envelope())).status, "already-applied");
});

test("本地 Source 分阶段诊断凭据解密与设置失败", async (t) => {
  const { root, repository } = await fixture(t);
  const credentialFilePath = join(root, "credentials.json");
  await writeFile(
    credentialFilePath,
    JSON.stringify({ "oauth:zai:access_token": "fixture-encrypted" }),
  );
  const options = {
    personalRepository: repository,
    personalConfigFilePath: join(root, "provider_config.json"),
    credentialFilePath,
    settingService: { get: async () => ({}) },
    cipherProvider: {
      decrypt() {
        throw Object.assign(new Error(sensitive), { code: "LCODE_CREDENTIAL_DECRYPT_FAILED" });
      },
    },
  };
  const source = createProviderProvisioningSource(options);
  const executor = createRemoteProviderProvisioningExecutor({
    source,
    target: {
      apply() {
        throw new Error("must not dispatch");
      },
    },
  });
  const result = await executor.syncLocalToRemote();
  assert.deepEqual(result.failure, { stage: "local-credentials", code: "credential-decrypt" });
  noSecrets(result);
  const settingsSource = createProviderProvisioningSource({
    ...options,
    cipherProvider: { decrypt: () => "fixture-value" },
    settingService: {
      get: async () => {
        throw Object.assign(new Error(sensitive), { code: "EACCES" });
      },
    },
  });
  await assert.rejects(settingsSource.read("fixture-sync"), (error) => {
    assert.equal(error.failure.stage, "local-settings");
    assert.equal(error.failure.systemCode, "EACCES");
    return true;
  });
});

test("Host 丢弃旧远端自由文本，并阻止未校验诊断字段进入 IPC", async () => {
  const executor = createRemoteProviderProvisioningExecutor({
    source: { read: async () => envelope() },
    target: {
      apply: async () => ({
        syncId: "fixture",
        status: "failed",
        personalProviderCount: 0,
        credentialCount: 0,
        errorMessage: sensitive,
        rolledBack: true,
        failure: { stage: "remote-runtime", code: "builtin-unavailable", message: sensitive },
      }),
    },
  });
  const result = await executor.syncLocalToRemote();
  assert.deepEqual(result.failure, { stage: "remote-request", code: "diagnostics-unavailable" });
  noSecrets(result);
});
