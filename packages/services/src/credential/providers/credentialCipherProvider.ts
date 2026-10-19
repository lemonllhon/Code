import { join } from "node:path";
import { prepareLCodeCredentialStore, type LCodeCredentialCipher } from "@lcode/shared/node";
import { getAppConfigDir } from "../../paths.js";

export type CredentialCipherProvider = LCodeCredentialCipher;

interface CredentialCipherProviderOptions {
  env?: NodeJS.ProcessEnv;
  credentialFilePath?: string;
}

/** 密钥与迁移统一由 shared Node owner 管理，services 不再自行派生机器 key。 */
export function createCredentialCipherProvider(
  options: CredentialCipherProviderOptions = {},
): Promise<CredentialCipherProvider> {
  return prepareLCodeCredentialStore(
    options.credentialFilePath ?? join(getAppConfigDir(), "credentials.json"),
    { env: options.env },
  );
}
