import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { CREDENTIAL_DECRYPT_ERROR_CODE, CREDENTIAL_DECRYPT_ERROR_PREFIX } from "../oauth.js";

export const LCODE_CREDENTIAL_PREFIX = "enc:lcode:v2:";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface LCodeCredentialCipher {
  encrypt(value: string): string;
  decrypt(value: string): string;
}

export function credentialDecryptError(reason: string): Error {
  return Object.assign(new Error(`${CREDENTIAL_DECRYPT_ERROR_PREFIX}${reason}`), {
    code: CREDENTIAL_DECRYPT_ERROR_CODE,
  });
}

/** 只持有 LCode 的 key；旧品牌解密能力只能存在于一次性迁移边界。 */
export function createLCodeCipher(key: Buffer): LCodeCredentialCipher {
  return {
    encrypt(value) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const payload = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return `${LCODE_CREDENTIAL_PREFIX}${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${payload.toString("base64url")}`;
    },
    decrypt(value) {
      if (!value.startsWith("enc:")) return value;
      if (!value.startsWith(LCODE_CREDENTIAL_PREFIX)) {
        throw credentialDecryptError("凭据需要先完成 LCode 独立密钥迁移");
      }
      return decryptCredentialPayload(value.slice(LCODE_CREDENTIAL_PREFIX.length), key);
    },
  };
}

export function decryptCredentialPayload(payload: string, key: Buffer): string {
  const parts = payload.split(".");
  const [ivRaw, tagRaw, dataRaw] = parts;
  if (parts.length !== 3 || !ivRaw || !tagRaw || dataRaw === undefined) {
    throw credentialDecryptError("密文格式非法");
  }
  const iv = Buffer.from(ivRaw, "base64url");
  const tag = Buffer.from(tagRaw, "base64url");
  const data = Buffer.from(dataRaw, "base64url");
  if (
    iv.length !== IV_BYTES ||
    tag.length !== TAG_BYTES ||
    iv.toString("base64url") !== ivRaw ||
    tag.toString("base64url") !== tagRaw ||
    data.toString("base64url") !== dataRaw
  ) {
    throw credentialDecryptError("密文格式非法");
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    throw credentialDecryptError("密钥不匹配或密文已损坏");
  }
}
