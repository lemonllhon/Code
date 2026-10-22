import { randomUUID } from "node:crypto";
import { storeSchema } from "./providerAccountStoreSchema.js";
import { exportPortableProviderGrant } from "@lcode/provider-node";
import type { StoredAccount } from "./providerAccountStoreSchema.js";

export interface ProviderAccountBackupPort {
  exportBackupAccounts(): Promise<StoredAccount[]>;
  readBackupTransactionAccounts(): Promise<StoredAccount[]>;
  replaceBackupAccounts(input: StoredAccount[]): Promise<void>;
}
const backupPorts = new WeakMap<object, ProviderAccountBackupPort>();
export function registerProviderAccountBackupPort(owner: object, port: ProviderAccountBackupPort) {
  backupPorts.set(owner, port);
}
export function getProviderAccountBackupPort(owner: object): ProviderAccountBackupPort {
  const port = backupPorts.get(owner);
  if (!port) throw new Error("Provider account backup port is unavailable");
  return port;
}
export function exportProviderBackupAccounts(accounts: StoredAccount[]): StoredAccount[] {
  return accounts.map((account) => {
    const portable = exportPortableProviderGrant(account.channelId, account.grant);
    return {
      connectionId: account.connectionId,
      channelId: account.channelId,
      displayName: account.displayName,
      enabled: account.enabled,
      generation: 0,
      grant: portable.grant,
      models: account.models,
      ...(portable.requiresAuthorization
        ? { error: "OAUTH_REAUTHORIZATION_REQUIRED", authorizationStatus: "expired" as const }
        : {}),
    };
  });
}

export async function replaceProviderBackupAccounts(
  input: StoredAccount[],
  mutate: (update: (accounts: StoredAccount[]) => void) => Promise<void>,
): Promise<Set<string>> {
  const incoming = storeSchema.parse({ version: 1, accounts: input }).accounts;
  const changedIds = new Set<string>();
  await mutate((accounts) => {
    const previous = new Map(accounts.map((account) => [account.connectionId, account]));
    for (const account of accounts)
      if (!incoming.some((item) => item.connectionId === account.connectionId))
        changedIds.add(account.connectionId);
    accounts.splice(
      0,
      accounts.length,
      ...incoming.map((account) => {
        const existing = previous.get(account.connectionId);
        if (existing && JSON.stringify(existing) === JSON.stringify(account)) return existing;
        changedIds.add(account.connectionId);
        return {
          ...account,
          generation: (existing?.generation ?? 0) + 1,
          routingEpoch: (existing?.routingEpoch ?? 0) + 1,
          restoreEpoch: randomUUID(),
          enabled: account.authorizationStatus === "expired" ? false : account.enabled,
        };
      }),
    );
  });
  return changedIds;
}
