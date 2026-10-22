import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateTextFile, withProviderMutationBarrier } from "@lcode/shared/node";
import { decodeProviderConfigFile, encodeProviderConfigFile } from "@lcode/provider-node";
import type { PersonalProviderConfigRepository } from "@lcode/provider";
import type { BackupSourcePort } from "../backup/node.js";
import type { ICredentialService } from "../credential/credential.js";
import type { ProviderAccountBackupPort } from "./providerAccounts.js";
import { readProvisionablePersonalConfig } from "./providerProvisioningSource.js";
import {
  parseProviderBackupData,
  planProviderBackupMerge,
  providerBackupRevision,
  providerBackupSnapshot,
  type ProviderBackupData,
} from "./providerBackupModel.js";
export interface ProviderBackupSourceOptions {
  profileDir: string;
  personalFilePath: string;
  personalRepository: PersonalProviderConfigRepository;
  accounts: ProviderAccountBackupPort;
  credentials: ICredentialService;
  refresh(): Promise<void>;
  validatePersonal?(personal: ProviderBackupData["personal"], providerIds: string[]): Promise<void>;
}
/** 原 owner 的事务适配器；恢复日志只保留本次配置域，不读取整个凭据库。 */
export function createProviderBackupSource(options: ProviderBackupSourceOptions) {
  const journal = join(options.profileDir, "provider-backup-restore.json");
  const keyName = "provider-backup-rollback-key-v1";
  const barrier = <T>(operation: () => Promise<T>) =>
    withProviderMutationBarrier(options.personalFilePath, operation, true);
  const read = async (portable = false): Promise<ProviderBackupData> =>
    parseProviderBackupData({
      version: 1,
      personal: encodeProviderConfigFile(
        await readProvisionablePersonalConfig(options.personalRepository, options.personalFilePath),
      ),
      accounts: portable
        ? await options.accounts.exportBackupAccounts()
        : await options.accounts.readBackupTransactionAccounts(),
    });
  async function write(data: ProviderBackupData) {
    await options.accounts.replaceBackupAccounts(data.accounts);
    await options.personalRepository.update(() => decodeProviderConfigFile(data.personal));
  }
  async function saveRollback(data: ProviderBackupData) {
    let stored = await options.credentials.load(keyName);
    if (!stored) {
      stored = randomBytes(32).toString("base64");
      await options.credentials.save(keyName, stored);
    }
    const key = Buffer.from(stored, "base64");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from("provider-rollback/v1"));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
    await atomicWritePrivateTextFile(
      journal,
      JSON.stringify({
        version: 1,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: encrypted.toString("base64"),
      }),
    );
  }
  async function recover() {
    let raw: string;
    try {
      raw = await readFile(journal, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    const record = JSON.parse(raw);
    const stored = await options.credentials.load(keyName);
    if (!stored || record.version !== 1)
      throw new Error("Provider restore journal cannot be unlocked");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(stored, "base64"),
      Buffer.from(record.iv, "base64"),
    );
    decipher.setAAD(Buffer.from("provider-rollback/v1"));
    decipher.setAuthTag(Buffer.from(record.tag, "base64"));
    const data = parseProviderBackupData(
      JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(record.data, "base64")),
          decipher.final(),
        ]).toString("utf8"),
      ),
    );
    await write(data);
    await unlink(journal);
    return true;
  }
  const ready = barrier(recover).then(async (recovered) => {
    if (recovered) await options.refresh();
  });
  const port: BackupSourcePort = {
    async capture(selection) {
      await ready;
      return barrier(async () => providerBackupSnapshot(await read(true), selection));
    },
    async inspect(snapshot, request) {
      await ready;
      return barrier(async () => {
        const current = await read();
        const plan = planProviderBackupMerge(
          current,
          parseProviderBackupData(snapshot.data),
          snapshot,
          request,
        );
        await options.validatePersonal?.(
          plan.data.personal,
          plan.changes
            .filter((change) => change.action === "add" || change.action === "replace")
            .map((change) => change.id),
        );
        return {
          revision: providerBackupRevision(current),
          changes: plan.changes,
          warnings: plan.warnings,
        };
      });
    },
    async restore(snapshot, request, revision) {
      await ready;
      try {
        return await barrier(async () => {
          const current = await read();
          if (providerBackupRevision(current) !== revision)
            throw new Error("Provider configuration changed after preview");
          const plan = planProviderBackupMerge(
            current,
            parseProviderBackupData(snapshot.data),
            snapshot,
            request,
          );
          await options.validatePersonal?.(
            plan.data.personal,
            plan.changes
              .filter((change) => change.action === "add" || change.action === "replace")
              .map((change) => change.id),
          );
          if (JSON.stringify(plan.data) === JSON.stringify(current))
            return { restored: 0, warnings: plan.warnings };
          await saveRollback(current);
          try {
            await write(plan.data);
            await atomicWritePrivateTextFile(
              join(options.profileDir, "provider-backup-last-rollback.json"),
              await readFile(journal, "utf8"),
            );
            await unlink(journal);
          } catch (error) {
            try {
              await recover();
            } catch {
              throw new Error(
                "Provider restore failed and rollback needs repair; recovery journal was retained",
              );
            }
            throw error;
          }
          return {
            restored: plan.changes.filter((change) => change.action !== "keep").length,
            warnings: plan.warnings,
          };
        });
      } finally {
        await options.refresh();
      }
    },
  };
  return { port, ready };
}
