import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  gitNetworkOperationSchema,
  type GitNetworkOperation,
  type GitOperationQuery,
} from "@lcode/shared";
import { atomicWritePrivateTextFile, withFileLock } from "@lcode/shared/node";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export const gitOperationKey = (query: GitOperationQuery) =>
  hash(JSON.stringify([query.workspaceIdentity?.trim() || query.workspacePath, query.requestId]));
const recordSchema = z
  .object({ fingerprint: z.string(), receipt: gitNetworkOperationSchema })
  .strict();
type Record = z.infer<typeof recordSchema>;

/** 只持久化命令结算，不缓存仓库事实或原始 URL/凭据。running 永不自动重放。 */
export class GitNetworkJournal {
  private readonly memory = new Map<string, Record>();
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly active = new Set<string>();
  constructor(private readonly dataDir?: string) {}
  private key(query: GitOperationQuery) {
    return gitOperationKey(query);
  }
  private path(key: string) {
    return this.dataDir ? join(this.dataDir, "network-operations", `${key}.json`) : null;
  }
  private async read(key: string): Promise<Record | null> {
    const path = this.path(key);
    if (!path) return this.memory.get(key) ?? null;
    try {
      return recordSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  private async save(key: string, record: Record) {
    const path = this.path(key);
    if (path) await atomicWritePrivateTextFile(path, JSON.stringify(recordSchema.parse(record)));
    else this.memory.set(key, structuredClone(record));
  }
  private async lock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const path = this.path(key);
    if (path) return withFileLock(path, action, { lockMaxWaitMs: 30_000 });
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.tails.set(key, next);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === next) this.tails.delete(key);
    }
  }
  async get(query: GitOperationQuery): Promise<GitNetworkOperation | null> {
    const key = this.key(query);
    const record = await this.read(key);
    if (!record) return null;
    return record.receipt.status === "running" && !this.active.has(key)
      ? { ...record.receipt, status: "unknown", code: "outcome-unknown" }
      : record.receipt;
  }
  async reserved(scope: { workspacePath: string; workspaceIdentity?: string }, key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid operation key");
    const record = await this.read(key);
    if (!record || this.key({ ...scope, requestId: record.receipt.requestId }) !== key) return null;
    return this.get({ ...scope, requestId: record.receipt.requestId });
  }
  async markResolved(query: GitOperationQuery) {
    const key = this.key(query);
    await this.lock(key, async () => {
      const record = await this.read(key);
      if (!record) throw new Error("Missing original Git operation");
      await this.save(key, { ...record, receipt: { ...record.receipt, resolved: true } });
    });
  }
  async markUnsettled(query: GitOperationQuery) {
    const key = this.key(query);
    await this.lock(key, async () => {
      const record = await this.read(key);
      if (!record) throw new Error("Missing original Git operation");
      await this.save(key, { ...record, receipt: { ...record.receipt, unsettled: true } });
    });
  }
  async updateIntegration(query: GitOperationQuery, effect: Partial<GitNetworkOperation>) {
    const key = this.key(query);
    await this.lock(key, async () => {
      const record = await this.read(key);
      if (
        !record?.receipt.integration ||
        !["merge", "rebase", "cherry-pick", "revert"].includes(record.receipt.kind)
      )
        throw new Error("Missing integration owner");
      const { status, after, conflicts, code, resolved, unsettled } = effect;
      await this.save(key, {
        ...record,
        receipt: gitNetworkOperationSchema.parse({
          ...record.receipt,
          status,
          after,
          conflicts,
          code,
          resolved,
          unsettled,
          finishedAt: new Date().toISOString(),
        }),
      });
    });
  }
  async run(
    kind: GitNetworkOperation["kind"],
    params: GitOperationQuery,
    perform: (
      checkpoint: (effect: Partial<GitNetworkOperation>) => Promise<void>,
    ) => Promise<Partial<GitNetworkOperation>>,
  ): Promise<GitNetworkOperation> {
    const key = this.key(params);
    const fingerprint = hash(JSON.stringify([kind, params]));
    const existing = await this.lock(key, async () => {
      const record = await this.read(key);
      if (record) {
        if (record.fingerprint !== fingerprint)
          throw new Error("requestId already belongs to different Git parameters");
        return await this.get(params);
      }
      this.active.add(key);
      await this.save(key, {
        fingerprint,
        receipt: {
          requestId: params.requestId,
          kind,
          status: "running",
          startedAt: new Date().toISOString(),
        },
      });
      return null;
    });
    if (existing) return existing;
    let effect: Partial<GitNetworkOperation>;
    try {
      effect = await perform(async (progress) => {
        await this.lock(key, async () => {
          const record = (await this.read(key))!;
          await this.save(key, {
            ...record,
            receipt: gitNetworkOperationSchema.parse({
              ...record.receipt,
              ...progress,
              status: "running",
            }),
          });
        });
      });
    } catch (error) {
      const progress = await this.read(key);
      effect = {
        status: progress?.receipt.results?.some((result) => result.status === "success")
          ? "partial"
          : "failed",
        code: error instanceof GitNetworkError ? error.code : "git-command-failed",
      };
    }
    try {
      return await this.lock(key, async () => {
        const record = (await this.read(key))!;
        const receipt = gitNetworkOperationSchema.parse({
          ...record.receipt,
          ...effect,
          finishedAt: new Date().toISOString(),
        });
        await this.save(key, { fingerprint, receipt });
        return receipt;
      });
    } finally {
      this.active.delete(key);
    }
  }
}

export class GitNetworkError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
