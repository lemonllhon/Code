import { createHash } from "node:crypto";
import { homedir, platform, userInfo } from "node:os";
import {
  credentialDecryptError,
  decryptCredentialPayload,
  LCODE_CREDENTIAL_PREFIX,
  type LCodeCredentialCipher,
} from "./lcodeCredentialCipher.js";

const LEGACY_PREFIX = "enc:v1:";

function legacyKeys(env: NodeJS.ProcessEnv): Buffer[] {
  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    /* 与历史派生规则保持一致。 */
  }
  return [
    env.LCODE_CREDENTIAL_SECRET,
    env.LCODE_CREDENTIAL_SECRET?.trim(),
    `lcode-credential-fallback:${platform()}:${homedir()}:${username}`,
    env.ZCODE_CREDENTIAL_SECRET,
    env.ZCODE_CREDENTIAL_SECRET?.trim(),
    `zcode-credential-fallback:${platform()}:${homedir()}:${username}`,
  ]
    .filter((secret): secret is string => Boolean(secret))
    .map((secret) => createHash("sha256").update(secret).digest());
}

/** 只转换传入的 LCode 副本，不读取或修改 ZCode 数据根。 */
export function migrateLegacyCredentialRecord(
  record: Record<string, unknown>,
  cipher: LCodeCredentialCipher,
  env: NodeJS.ProcessEnv,
): { record: Record<string, unknown>; changed: boolean } {
  const next = { ...record };
  let changed = false;
  let keys: Buffer[] | undefined;
  for (const [name, value] of Object.entries(record)) {
    if (typeof value !== "string") continue;
    if (value.startsWith(LCODE_CREDENTIAL_PREFIX)) {
      cipher.decrypt(value);
      continue;
    }
    let plaintext = value;
    if (value.startsWith(LEGACY_PREFIX)) {
      keys ??= legacyKeys(env);
      plaintext = decryptLegacy(value, keys);
    } else if (value.startsWith("enc:")) {
      throw credentialDecryptError("未知凭据密文版本");
    }
    // 修复：复制旧密文却只更改品牌派生前缀会使首次 Provisioning 解密失败；
    // 旧 key 仅在这里读取，所有新密文都由独立的 LCode key 生成。
    next[name] = cipher.encrypt(plaintext);
    changed = true;
  }
  if (typeof next.zcodejwttoken === "string" && !Object.hasOwn(next, "lcodejwttoken")) {
    next.lcodejwttoken = next.zcodejwttoken;
    changed = true;
  }
  return { record: next, changed };
}

function decryptLegacy(value: string, keys: readonly Buffer[]): string {
  for (const key of keys) {
    try {
      return decryptCredentialPayload(value.slice(LEGACY_PREFIX.length), key);
    } catch {
      /* 认证失败时仅尝试下一个明确的历史 key，不把坏密文当作明文。 */
    }
  }
  throw credentialDecryptError("旧凭据无法迁移，缺少匹配的旧密钥或密文已损坏");
}
