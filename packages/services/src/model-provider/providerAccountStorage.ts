import { randomUUID } from "node:crypto";
import {
  watchFileInvalidation,
  withFileLock,
  withProviderMutationBarrier,
} from "@lcode/shared/node";
import type { ICredentialService } from "../credential/credential.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { storeSchema, type StoredAccount } from "./providerAccountStoreSchema.js";

const STORE_KEY = "model-provider-oauth-accounts-v1";
const HOST_KEY = "model-provider-oauth-host-id-v1";
export class ProviderAccountStorage {
  constructor(
    private readonly credentials: ICredentialService,
    private readonly lockPath: string,
  ) {}
  async read(): Promise<StoredAccount[]> {
    return withProviderMutationBarrier(this.lockPath, async () => {
      const raw = await this.credentials.load(STORE_KEY);
      return raw ? storeSchema.parse(JSON.parse(raw)).accounts : [];
    });
  }
  async hostId(): Promise<string> {
    return withFileLock(this.lockPath, async () => {
      const stored = await this.credentials.load(HOST_KEY);
      if (stored && /^urn:uuid:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(stored))
        return stored;
      // 上游把机器标识作为API授权身份的一部分，不能在每次登录时重新随机生成。
      const id = `urn:uuid:${randomUUID()}`;
      await this.credentials.save(HOST_KEY, id);
      return id;
    });
  }
  async mutate(update: (accounts: StoredAccount[]) => void): Promise<void> {
    return withProviderMutationBarrier(this.lockPath, () => this.#mutateLocked(update));
  }
  async #mutateLocked(update: (accounts: StoredAccount[]) => void): Promise<void> {
    await withFileLock(this.lockPath, async () => {
      const accounts = await this.read();
      update(accounts);
      await this.credentials.save(STORE_KEY, JSON.stringify({ version: 1, accounts }));
    });
  }
  async readPublic() {
    return (await this.read()).map(
      ({ grant: _grant, generation: _generation, restoreEpoch: _epoch, ...account }) => account,
    );
  }
}

/** 原子凭据文件替换发生在其他window-scoped Host时，也要通知当前Registry重读。 */
export function watchProviderAccountStorage(
  file: string | undefined,
  onChange: (signal: AbortSignal) => Promise<void>,
): { ready: Promise<void>; dispose: () => void } {
  if (!file) return { ready: Promise.resolve(), dispose: () => {} };
  return watchFileInvalidation({
    filePath: file,
    onInvalidate: onChange,
    onError: (_error, phase) =>
      createServiceLogger("provider-accounts").warn(
        undefined,
        phase === "watch"
          ? "Account change observation failed; reload settings to refresh"
          : "Account change refresh failed; observation remains active",
      ),
  });
}

export function authorizationFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/claude/iu.test(message) && /install|required|not found|enoent|dependency/iu.test(message))
    return "OAUTH_CLAUDE_CLI_REQUIRED";
  if (/grok/iu.test(message) && /install|required|not found|enoent|dependency/iu.test(message))
    return "OAUTH_GROK_CLI_REQUIRED";
  return "OAUTH_AUTHORIZATION_FAILED";
}
