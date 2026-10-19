import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat, symlink } from "node:fs/promises";
import { homedir, platform, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { prepareLCodeCredentialStore } from "./lcodeCredentialStore.js";
import { decryptCredentialPayload } from "./lcodeCredentialCipher.js";

const STRONG_SECRET = "fixture-only-lcode-secret-32-bytes-minimum";
const OTHER_SECRET = "fixture-only-other-secret-32-bytes-minimum";

function encryptLegacy(value: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

function legacySecret(brand: string): string {
  return `${brand}-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`;
}

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "lcode-credential-key-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, ".lcode", "v2", "credentials.json");
  await mkdir(dirname(file), { recursive: true });
  return { root, file, keyFile: join(dirname(file), "credentials.key") };
}

test("默认每目录生成独立的 256 位随机 key，日常 cipher 拒绝旧密文", async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  const a = await prepareLCodeCredentialStore(first.file, { env: {} });
  const b = await prepareLCodeCredentialStore(second.file, { env: {} });
  const keyA = JSON.parse(await readFile(first.keyFile, "utf8"));
  const keyB = JSON.parse(await readFile(second.keyFile, "utf8"));
  assert.equal(Buffer.from(keyA.key, "base64url").length, 32);
  assert.notEqual(keyA.key, keyB.key);
  const encrypted = a.encrypt("fixture-token");
  assert.ok(encrypted.startsWith("enc:lcode:v2:"));
  assert.equal(a.decrypt(encrypted), "fixture-token");
  assert.notEqual(a.encrypt("fixture-token"), encrypted);
  assert.throws(() => b.decrypt(encrypted), { code: "LCODE_CREDENTIAL_DECRYPT_FAILED" });
  assert.throws(() => a.decrypt(encryptLegacy("old", legacySecret("zcode"))));
  if (platform() !== "win32") assert.equal((await stat(first.keyFile)).mode & 0o777, 0o600);
  await assert.rejects(readFile(first.file), { code: "ENOENT" });
});

test("旧 ZCode 副本一次性重加密、补新键、源文件不变且重入不写", async (t) => {
  const { root, file, keyFile } = await fixture(t);
  const source = join(root, ".zcode", "v2", "credentials.json");
  const raw = JSON.stringify({
    zcodejwttoken: encryptLegacy("fixture-jwt", legacySecret("zcode")),
    "oauth:active_provider": encryptLegacy("bigmodel", legacySecret("zcode")),
    "account-provider:fixture:api-key": encryptLegacy("fixture-api-key", legacySecret("zcode")),
  });
  await mkdir(dirname(source), { recursive: true });
  await writeFile(source, raw);
  await writeFile(file, raw);
  const cipher = await prepareLCodeCredentialStore(file, { env: {} });
  const migrated = await readFile(file, "utf8");
  const record = JSON.parse(migrated);
  assert.equal(cipher.decrypt(record.lcodejwttoken), "fixture-jwt");
  assert.equal(cipher.decrypt(record["account-provider:fixture:api-key"]), "fixture-api-key");
  assert.ok(Object.values(record).every((value) => String(value).startsWith("enc:lcode:v2:")));
  const key = await readFile(keyFile, "utf8");
  await prepareLCodeCredentialStore(file, { env: {} });
  assert.equal(await readFile(file, "utf8"), migrated);
  assert.equal(await readFile(keyFile, "utf8"), key);
  assert.equal(await readFile(source, "utf8"), raw);
  await assert.rejects(prepareLCodeCredentialStore(source, { env: {} }));
  assert.equal(await readFile(source, "utf8"), raw);
});

test("此前 LCode 派生 key、旧显式 secret 与明文均迁移到独立 key", async (t) => {
  const { file } = await fixture(t);
  await writeFile(
    file,
    JSON.stringify({
      lcode: encryptLegacy("lcode-token", legacySecret("lcode")),
      zcode: encryptLegacy("zcode-token", "fixture-legacy-secret"),
      plain: "fixture-plaintext",
      ignored: { invalid: true },
    }),
  );
  const cipher = await prepareLCodeCredentialStore(file, {
    env: { ZCODE_CREDENTIAL_SECRET: "fixture-legacy-secret" },
  });
  const record = JSON.parse(await readFile(file, "utf8"));
  assert.equal(cipher.decrypt(record.lcode), "lcode-token");
  assert.equal(cipher.decrypt(record.zcode), "zcode-token");
  assert.equal(cipher.decrypt(record.plain), "fixture-plaintext");
  assert.deepEqual(record.ignored, { invalid: true });
});

test("LCode 强显式 secret 独立使用，弱 secret 不降级", async (t) => {
  const { file, keyFile } = await fixture(t);
  const raw = JSON.stringify({ token: encryptLegacy("fixture", STRONG_SECRET) });
  await writeFile(file, raw);
  await assert.rejects(
    prepareLCodeCredentialStore(file, {
      env: { LCODE_CREDENTIAL_SECRET: "weak" },
    }),
    { code: "LCODE_CREDENTIAL_SECRET_WEAK" },
  );
  assert.equal(await readFile(file, "utf8"), raw);
  const cipher = await prepareLCodeCredentialStore(file, {
    env: { LCODE_CREDENTIAL_SECRET: STRONG_SECRET, ZCODE_CREDENTIAL_SECRET: OTHER_SECRET },
  });
  const encrypted = JSON.parse(await readFile(file, "utf8")).token;
  assert.equal(cipher.decrypt(encrypted), "fixture");
  // 即使用户为两个应用配置相同文本，LCode v2 的域隔离也不能复用旧 AES key。
  assert.throws(() =>
    decryptCredentialPayload(
      encrypted.slice("enc:lcode:v2:".length),
      createHash("sha256").update(STRONG_SECRET).digest(),
    ),
  );
  await assert.rejects(readFile(keyFile), { code: "ENOENT" });
  const sameKey = await prepareLCodeCredentialStore(file, {
    env: { LCODE_CREDENTIAL_SECRET: STRONG_SECRET, ZCODE_CREDENTIAL_SECRET: "changed-old-secret" },
  });
  assert.equal(sameKey.decrypt(encrypted), "fixture");
  const before = await readFile(file, "utf8");
  await assert.rejects(
    prepareLCodeCredentialStore(file, {
      env: { LCODE_CREDENTIAL_SECRET: OTHER_SECRET },
    }),
  );
  assert.equal(await readFile(file, "utf8"), before);
});

test("迁移完整失败保留原文件，已生成 key 可在修复坏条目后继续", async (t) => {
  const { file, keyFile } = await fixture(t);
  const raw = JSON.stringify({
    good: encryptLegacy("fixture-good", legacySecret("zcode")),
    bad: encryptLegacy("fixture-bad", "unknown-secret"),
  });
  await writeFile(file, raw);
  await assert.rejects(prepareLCodeCredentialStore(file, { env: {} }));
  assert.equal(await readFile(file, "utf8"), raw);
  const key = await readFile(keyFile, "utf8");
  await writeFile(file, JSON.stringify({ good: JSON.parse(raw).good }));
  const cipher = await prepareLCodeCredentialStore(file, { env: {} });
  assert.equal(cipher.decrypt(JSON.parse(await readFile(file, "utf8")).good), "fixture-good");
  assert.equal(await readFile(keyFile, "utf8"), key);
});

test("丢失或损坏 key 不会重新生成并覆盖已有 v2 凭据", async (t) => {
  const { file, keyFile } = await fixture(t);
  const cipher = await prepareLCodeCredentialStore(file, { env: {} });
  const raw = JSON.stringify({ token: cipher.encrypt("fixture") });
  await writeFile(file, raw);
  await rm(keyFile);
  await assert.rejects(prepareLCodeCredentialStore(file, { env: {} }), {
    code: "LCODE_CREDENTIAL_KEY_MISSING",
  });
  await assert.rejects(readFile(keyFile), { code: "ENOENT" });
  await writeFile(keyFile, '{"schemaVersion":1,"key":"invalid"}');
  await assert.rejects(prepareLCodeCredentialStore(file, { env: {} }), {
    code: "LCODE_CREDENTIAL_KEY_INVALID",
  });
  assert.equal(await readFile(file, "utf8"), raw);
});

test("并发首次准备与迁移只创建一个 key，所有 caller 互相解密", async (t) => {
  const { file } = await fixture(t);
  await writeFile(file, JSON.stringify({ token: encryptLegacy("fixture", legacySecret("zcode")) }));
  const ciphers = await Promise.all(
    Array.from({ length: 12 }, () => prepareLCodeCredentialStore(file, { env: {} })),
  );
  const encrypted = ciphers[0]!.encrypt("concurrent");
  assert.ok(ciphers.every((cipher) => cipher.decrypt(encrypted) === "concurrent"));
  assert.equal(ciphers[0]!.decrypt(JSON.parse(await readFile(file, "utf8")).token), "fixture");
});

test("同目录不同凭据文件并发初始化也不能相互覆盖 key", async (t) => {
  const { file, keyFile } = await fixture(t);
  const ciphers = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      prepareLCodeCredentialStore(join(dirname(file), `fixture-${index}.json`), { env: {} }),
    ),
  );
  const encrypted = ciphers[0]!.encrypt("fixture-shared-directory");
  assert.ok(ciphers.every((cipher) => cipher.decrypt(encrypted) === "fixture-shared-directory"));
  await assert.rejects(prepareLCodeCredentialStore(keyFile, { env: {} }), {
    code: "LCODE_CREDENTIAL_PATH_INVALID",
  });
});

test("坏 JSON、篡改 v2 或未知加密格式均不覆盖凭据", async (t) => {
  const { file } = await fixture(t);
  for (const raw of [
    "{broken",
    '{"token":"enc:unknown:payload"}',
    '{"token":"enc:lcode:v2:invalid"}',
  ]) {
    await writeFile(file, raw);
    await assert.rejects(prepareLCodeCredentialStore(file, { env: {} }));
    assert.equal(await readFile(file, "utf8"), raw);
  }
});

test("认证标签篡改失败保留原文件，不能回退到旧 key", async (t) => {
  const { file } = await fixture(t);
  const cipher = await prepareLCodeCredentialStore(file, { env: {} });
  const encrypted = cipher.encrypt("fixture-value");
  const segments = encrypted.slice("enc:lcode:v2:".length).split(".");
  const tag = Buffer.from(segments[1]!, "base64url");
  tag[0] = tag[0]! ^ 1;
  segments[1] = tag.toString("base64url");
  const raw = JSON.stringify({ token: `enc:lcode:v2:${segments.join(".")}` });
  await writeFile(file, raw);
  await assert.rejects(prepareLCodeCredentialStore(file, { env: {} }));
  assert.equal(await readFile(file, "utf8"), raw);
});

test("目录链接不能让迁移在 ZCode 原目录创建 key 或锁", async (t) => {
  const { root } = await fixture(t);
  const sourceDir = join(root, ".zcode");
  const alias = join(root, "lcode-alias");
  await mkdir(sourceDir);
  try {
    await symlink(sourceDir, alias, "junction");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("当前系统不允许创建目录链接");
      return;
    }
    throw error;
  }
  await assert.rejects(
    prepareLCodeCredentialStore(join(alias, "v2", "credentials.json"), { env: {} }),
    {
      code: "LCODE_CREDENTIAL_PATH_INVALID",
    },
  );
  await assert.rejects(stat(join(sourceDir, "v2")), { code: "ENOENT" });
});
