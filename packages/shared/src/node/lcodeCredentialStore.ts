import { createHash, randomBytes } from "node:crypto";
import { readFile, lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "./privateFilePersistence.js";
import {
  createLCodeCipher,
  LCODE_CREDENTIAL_PREFIX,
  type LCodeCredentialCipher,
} from "./lcodeCredentialCipher.js";
import { migrateLegacyCredentialRecord } from "./legacyCredentialMigration.js";

export type { LCodeCredentialCipher } from "./lcodeCredentialCipher.js";

const KEY_BYTES = 32;
const KEY_FILE_NAME = "credentials.key";
const MIN_SECRET_BYTES = 32;
const EXPLICIT_KEY_DOMAIN = "lcode-credential-key:v2\0";

export interface LCodeCredentialStoreOptions {
  env?: NodeJS.ProcessEnv;
}

function keyError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function rejectZCodePath(filePath: string): void {
  if (
    resolve(filePath)
      .split(sep)
      .some((part) => part.toLowerCase() === ".zcode")
  ) {
    throw keyError("LCODE_CREDENTIAL_PATH_INVALID", "LCode 凭据迁移不能写入 ZCode 数据目录");
  }
}

async function assertLCodePath(filePath: string): Promise<void> {
  rejectZCodePath(filePath);
  // 防止自定义 filePath 或目录链接把一次性迁移指向仍由 ZCode 使用的原文件。
  const target = resolve(filePath);
  let candidate = target;
  for (;;) {
    try {
      if (candidate === target && (await lstat(candidate)).isSymbolicLink()) {
        throw keyError("LCODE_CREDENTIAL_PATH_INVALID", "LCode 凭据文件不能是符号链接");
      }
      rejectZCodePath(await realpath(candidate));
      return;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate)
      throw keyError("LCODE_CREDENTIAL_PATH_INVALID", "LCode 凭据目录不可用");
    candidate = parent;
  }
}

/** 唯一密钥/迁移 owner。调用方须在正常 Credential 写事务加锁前等待它完成。 */
export async function prepareLCodeCredentialStore(
  filePath: string,
  options: LCodeCredentialStoreOptions = {},
): Promise<LCodeCredentialCipher> {
  const env = options.env ?? process.env;
  const keyFile = join(dirname(filePath), KEY_FILE_NAME);
  if (resolve(filePath) === resolve(keyFile)) {
    throw keyError("LCODE_CREDENTIAL_PATH_INVALID", "凭据文件不能占用保留的密钥文件路径");
  }
  await assertLCodePath(filePath);
  return withFileLock(filePath, async () => {
    await assertLCodePath(filePath);
    const record = await readCredentialRecord(filePath);
    // 自定义凭据文件名也可能共享同一目录；必须按 key 文件串行初始化，
    // 不能只锁各自的凭据文件而让两个随机 key 相互覆盖。锁序固定为凭据 → key。
    const key = await withFileLock(keyFile, () => readLCodeKey(keyFile, record, env));
    const cipher = createLCodeCipher(key);
    const migrated = migrateLegacyCredentialRecord(record, cipher, env);
    if (migrated.changed) {
      await atomicWritePrivateTextFile(filePath, `${JSON.stringify(migrated.record, null, 2)}\n`);
    }
    return cipher;
  });
}

async function readCredentialRecord(filePath: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw keyError("LCODE_CREDENTIAL_STORE_INVALID", "LCode 凭据文件 JSON 损坏，已保留原文件");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw keyError("LCODE_CREDENTIAL_STORE_INVALID", "LCode 凭据文件必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

async function readLCodeKey(
  keyFile: string,
  record: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<Buffer> {
  const secret = env.LCODE_CREDENTIAL_SECRET;
  if (secret !== undefined && secret !== "") {
    if (Buffer.byteLength(secret.trim(), "utf8") < MIN_SECRET_BYTES) {
      throw keyError(
        "LCODE_CREDENTIAL_SECRET_WEAK",
        "LCODE_CREDENTIAL_SECRET 至少需要 32 字节；建议取消覆盖以使用随机密钥",
      );
    }
    return createHash("sha256").update(EXPLICIT_KEY_DOMAIN).update(secret).digest();
  }
  let raw: string;
  try {
    if ((await lstat(keyFile)).isSymbolicLink()) {
      throw keyError("LCODE_CREDENTIAL_KEY_INVALID", "LCode 密钥文件不能是符号链接");
    }
    raw = await readFile(keyFile, "utf8");
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    if (
      Object.values(record).some(
        (value) => typeof value === "string" && value.startsWith(LCODE_CREDENTIAL_PREFIX),
      )
    ) {
      throw keyError(
        "LCODE_CREDENTIAL_KEY_MISSING",
        "LCode 随机密钥文件丢失，已保留凭据，请恢复对应密钥",
      );
    }
    const key = randomBytes(KEY_BYTES);
    await atomicWritePrivateTextFile(
      keyFile,
      `${JSON.stringify({ schemaVersion: 1, key: key.toString("base64url") })}\n`,
    );
    return key;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed.schemaVersion !== 1 || typeof parsed.key !== "string") throw new Error();
    const key = Buffer.from(parsed.key, "base64url");
    if (key.length !== KEY_BYTES || key.toString("base64url") !== parsed.key) throw new Error();
    return key;
  } catch {
    throw keyError("LCODE_CREDENTIAL_KEY_INVALID", "LCode 随机密钥文件损坏，已保留原文件");
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
