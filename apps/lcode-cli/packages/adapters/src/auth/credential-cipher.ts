import { prepareLCodeCredentialStore, type LCodeCredentialCipher } from "@lcode/shared/node";

export type { LCodeCredentialCipher } from "@lcode/shared/node";

export interface LCodeCredentialCipherOptions {
  filePath: string;
  env?: Record<string, string | undefined>;
}

/** CLI 与 Desktop 使用相同的 LCode key owner，避免两个进程生成不同密钥。 */
export function createLCodeCredentialCipher(
  options: LCodeCredentialCipherOptions,
): Promise<LCodeCredentialCipher> {
  return prepareLCodeCredentialStore(options.filePath, { env: options.env });
}

export function isEncryptedLCodeCredentialValue(value: string): boolean {
  return value.startsWith("enc:lcode:v2:") || value.startsWith("enc:v1:");
}
