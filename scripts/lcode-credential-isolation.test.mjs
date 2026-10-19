import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, platform, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { prepareLCodeCredentialStore } from "../packages/shared/src/node/lcodeCredentialStore.ts";
import { createCredentialService } from "../packages/services/src/credential/credentialService.ts";
import { setDataBaseDir } from "../packages/services/src/paths.ts";
import { createProviderProvisioningSource } from "../packages/services/src/model-provider/providerProvisioningSource.ts";
import {
  decodeProviderConfigFile,
  encodeProviderConfigFile,
} from "../packages/provider-node/src/provider-config-file-codec.ts";
import { createSharedLCodeCredentialStore } from "../apps/lcode-cli/packages/adapters/src/auth/shared-credentials.ts";

const run = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "lcode-credential-integration-"));
  const file = join(root, ".lcode", "v2", "credentials.json");
  await mkdir(dirname(file), { recursive: true });
  const previousSecret = process.env.LCODE_CREDENTIAL_SECRET;
  delete process.env.LCODE_CREDENTIAL_SECRET;
  setDataBaseDir(root);
  t.after(async () => {
    setDataBaseDir(null);
    if (previousSecret === undefined) delete process.env.LCODE_CREDENTIAL_SECRET;
    else process.env.LCODE_CREDENTIAL_SECRET = previousSecret;
    await rm(root, { recursive: true, force: true });
  });
  return { root, file };
}

function legacy(value) {
  const secret = `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

test("Desktop services 与 CLI 共用 LCode key，条件写入和并发更新不丢凭据", async (t) => {
  const { file } = await fixture(t);
  const service = createCredentialService();
  const cli = createSharedLCodeCredentialStore({ filePath: file, env: {} });
  await service.save("fixture:desktop", "desktop-value");
  assert.equal(await cli.load("fixture:desktop"), "desktop-value");
  await cli.save("fixture:cli", "cli-value");
  assert.equal(await service.load("fixture:cli"), "cli-value");
  assert.equal(
    await cli.saveManyIfValues({ "fixture:cli": "wrong" }, { "fixture:cli": "lost" }),
    false,
  );
  assert.equal(
    await cli.saveManyIfValues({ "fixture:cli": "cli-value" }, { "fixture:cli": "next" }),
    true,
  );
  assert.equal(await service.load("fixture:cli"), "next");
  await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      index % 2
        ? service.save(`fixture:concurrent:${index}`, `value-${index}`)
        : cli.save(`fixture:concurrent:${index}`, `value-${index}`),
    ),
  );
  const values = await cli.loadMany(
    Array.from({ length: 10 }, (_, i) => `fixture:concurrent:${i}`),
  );
  assert.equal(Object.values(values).filter(Boolean).length, 10);
  assert.equal(await cli.deleteIfValue("fixture:cli", "wrong"), false);
  assert.equal(await cli.deleteIfValue("fixture:cli", "next"), true);
  assert.equal(await service.load("fixture:cli"), null);
  const record = JSON.parse(await readFile(file, "utf8"));
  assert.ok(Object.values(record).every((value) => value.startsWith("enc:lcode:v2:")));
});

test("Provider 首次同步迁移旧副本并导出 allowlist，远端使用不同 key", async (t) => {
  const { root, file } = await fixture(t);
  await writeFile(
    file,
    JSON.stringify({
      zcodejwttoken: legacy("fixture-jwt"),
      "account-provider:fixture:api-key": legacy("fixture-api-key"),
      "unrelated-broken-entry": { ignored: true },
    }),
  );
  const personalFile = join(dirname(file), "provider_config.json");
  const input = {
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  };
  await writeFile(personalFile, JSON.stringify(input));
  const personal = decodeProviderConfigFile(input);
  const revision = createHash("sha256")
    .update(JSON.stringify(encodeProviderConfigFile(personal)))
    .digest("hex");
  const source = createProviderProvisioningSource({
    personalRepository: { read: async () => ({ ...personal, revision }) },
    settingService: { get: async () => ({}) },
    credentialFilePath: file,
    personalConfigFilePath: personalFile,
  });
  const envelope = await source.read("fixture-provisioning-sync");
  assert.equal(envelope.credentials.length, 2);
  assert.equal(
    envelope.credentials.find((entry) => entry.key === "lcodejwttoken").value,
    "fixture-jwt",
  );
  const localKey = JSON.parse(await readFile(join(dirname(file), "credentials.key"), "utf8"));
  assert.ok(!JSON.stringify(envelope).includes(localKey.key));
  const remoteRoot = join(root, "remote-host");
  setDataBaseDir(remoteRoot);
  const remote = createCredentialService();
  for (const entry of envelope.credentials) await remote.save(entry.key, entry.value);
  const remoteFile = join(remoteRoot, ".lcode", "v2", "credentials.json");
  const remoteCipher = await prepareLCodeCredentialStore(remoteFile, { env: {} });
  const remoteKey = JSON.parse(
    await readFile(join(dirname(remoteFile), "credentials.key"), "utf8"),
  );
  assert.notEqual(remoteKey.key, localKey.key);
  const localRecord = JSON.parse(await readFile(file, "utf8"));
  assert.throws(() => remoteCipher.decrypt(localRecord.lcodejwttoken));
  assert.equal(await remote.load("lcodejwttoken"), "fixture-jwt");
});

test("独立 Node 进程同时首次迁移和写入，共用文件锁与随机 key", async (t) => {
  const { file } = await fixture(t);
  await writeFile(file, JSON.stringify({ old: legacy("fixture-old") }));
  const url = pathToFileURL(
    resolve("apps/lcode-cli/packages/adapters/src/auth/shared-credentials.ts"),
  ).href;
  const code = `import { createSharedLCodeCredentialStore } from ${JSON.stringify(url)};
    const store = createSharedLCodeCredentialStore({ filePath: process.argv[1], env: {} });
    await store.save(process.argv[2], process.argv[2]);`;
  await Promise.all(
    Array.from({ length: 3 }, (_, i) =>
      run(process.execPath, [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        code,
        file,
        `fixture-child-${i}`,
      ]),
    ),
  );
  const cli = createSharedLCodeCredentialStore({ filePath: file, env: {} });
  assert.equal(await cli.load("old"), "fixture-old");
  for (let i = 0; i < 3; i++)
    assert.equal(await cli.load(`fixture-child-${i}`), `fixture-child-${i}`);
});

test("日志导出收集器排除 LCode 随机 key，包括私有原子写临时文件", async () => {
  const source = await readFile(
    new URL("../packages/desktop/src/main/exportLogs.ts", import.meta.url),
    "utf8",
  );
  const names = source.match(
    /const SENSITIVE_CREDENTIAL_ARCHIVE_FILE_NAMES = new Set\((\[[\s\S]*?\])\);/,
  )[1];
  const fn = source.match(
    /function isSensitiveCredentialArchivePath\(relativePath: string\): boolean \{([\s\S]*?)\n\}/,
  )[1];
  const isExcluded = new Function(
    "relativePath",
    `const SENSITIVE_CREDENTIAL_ARCHIVE_FILE_NAMES = new Set(${names});
    const normalizeArchivePath = path => path.replaceAll('\\\\', '/'); ${fn}`,
  );
  for (const name of [
    "credentials.key",
    "runtime/CREDENTIALS.KEY",
    "nested/.credentials.key.123.456.tmp",
  ])
    assert.equal(isExcluded(name), true, name);
  assert.equal(isExcluded("logs/2026-01-01.log"), false);
});
