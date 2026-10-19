import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  MEMORY_LEARNING_BYTES_LIMIT,
  MEMORY_LEARNING_LEASE_MS,
  MEMORY_LEARNING_RECORD_LIMIT,
  MemoryLearningLeaseSchema,
  MemoryLearningLedgerSchema,
  type MemoryLearningLease,
  type MemoryLearningLedger as Ledger,
  type ProjectMemoryLearningPort,
  type ProjectMemoryOperationOptions,
} from "@lcode/contracts";
import { throwIfAborted } from "./file-system-common.js";
import { memoryError, readMemoryBytes, strictAtomicWrite } from "./project-memory-io.js";
import { assertMemoryRoot, samePath, type MemoryRoot } from "./project-memory-paths.js";
import type { MemoryStore } from "./project-memory-store.js";

const LEDGER_FILE = "learning.json";
type WithRoot = <T>(
  rootDir: string,
  run: (state: { store: MemoryStore }) => Promise<T>,
  options?: ProjectMemoryOperationOptions,
) => Promise<T>;

/** 消费记录与原正文写入共用锁；租约 token 阻止过期执行者提交新持有者的结果。 */
export class MemoryLearning implements ProjectMemoryLearningPort {
  constructor(private readonly withRoot: WithRoot) {}

  private async load(root: MemoryRoot): Promise<Ledger> {
    const bytes = await readMemoryBytes(
      join(root.stateDir, LEDGER_FILE),
      MEMORY_LEARNING_BYTES_LIMIT,
      true,
    );
    if (bytes === null) return { schemaVersion: 1, rootDir: root.rootDir, records: [] };
    let ledger: Ledger;
    try {
      ledger = MemoryLearningLedgerSchema.parse(JSON.parse(bytes.toString("utf8")));
    } catch {
      throw memoryError("io_error", root.rootDir, "Invalid memory learning ledger");
    }
    const keys = new Set(
      ledger.records.map((r) => JSON.stringify([r.workspaceKey, r.evidenceKey])),
    );
    if (!samePath(ledger.rootDir, root.rootDir) || keys.size !== ledger.records.length)
      throw memoryError("invalid_path", root.rootDir, "Memory learning owner or keys differ");
    return ledger;
  }

  private async save(
    root: MemoryRoot,
    ledger: Ledger,
    options?: ProjectMemoryOperationOptions,
  ): Promise<boolean> {
    throwIfAborted(options?.signal);
    const bytes = Buffer.from(JSON.stringify(ledger));
    if (bytes.length > MEMORY_LEARNING_BYTES_LIMIT) return false;
    await strictAtomicWrite(join(root.stateDir, LEDGER_FILE), bytes, {
      mode: 0o600,
      signal: options?.signal,
      validate: () => assertMemoryRoot(root),
    });
    return true;
  }

  claim(
    input: Parameters<ProjectMemoryLearningPort["claim"]>[0],
    options?: ProjectMemoryOperationOptions,
  ): ReturnType<ProjectMemoryLearningPort["claim"]> {
    return this.withRoot(
      input.rootDir,
      async ({ store }) => {
        const lease = MemoryLearningLeaseSchema.parse({
          workspaceKey: input.workspaceKey,
          evidenceKey: input.evidenceKey,
          token: randomUUID(),
          expiresAt: Date.now() + MEMORY_LEARNING_LEASE_MS,
        });
        const ledger = await this.load(store.root);
        const prior = ledger.records.find(
          (r) => r.workspaceKey === lease.workspaceKey && r.evidenceKey === lease.evidenceKey,
        );
        if (prior?.consumed) return { status: "consumed" };
        if (prior && prior.lease.expiresAt > Date.now()) return { status: "busy" };
        if (!prior && ledger.records.length >= MEMORY_LEARNING_RECORD_LIMIT)
          return { status: "full" };
        const record = {
          workspaceKey: lease.workspaceKey,
          evidenceKey: lease.evidenceKey,
          lease,
          consumed: false,
        };
        if (prior) Object.assign(prior, record);
        else ledger.records.push(record);
        return (await this.save(store.root, ledger, options))
          ? { status: "claimed", lease }
          : { status: "full" };
      },
      options,
    );
  }

  async assertLease(root: MemoryRoot, input: MemoryLearningLease): Promise<void> {
    const lease = MemoryLearningLeaseSchema.parse(input);
    const ledger = await this.load(root);
    if (
      !ledger.records.some((r) => !r.consumed && sameLease(r.lease, lease)) ||
      lease.expiresAt <= Date.now()
    )
      throw memoryError("stale_write", root.rootDir, "Memory learning lease is no longer current");
  }

  finish(
    input: Parameters<ProjectMemoryLearningPort["finish"]>[0],
    options?: ProjectMemoryOperationOptions,
  ): Promise<void> {
    return this.withRoot(
      input.rootDir,
      async ({ store }) => {
        const lease = MemoryLearningLeaseSchema.parse(input.lease);
        const ledger = await this.load(store.root);
        const record = ledger.records.find((r) => sameLease(r.lease, lease));
        if (!record || (!record.consumed && lease.expiresAt <= Date.now()))
          throw memoryError(
            "stale_write",
            input.rootDir,
            "Memory learning lease is no longer current",
          );
        record.consumed = true;
        if (!(await this.save(store.root, ledger, options)))
          throw memoryError("too_large", input.rootDir, "Memory learning ledger is full");
      },
      options,
    );
  }

  release(
    input: Parameters<ProjectMemoryLearningPort["release"]>[0],
    options?: ProjectMemoryOperationOptions,
  ): Promise<void> {
    return this.withRoot(
      input.rootDir,
      async ({ store }) => {
        const lease = MemoryLearningLeaseSchema.parse(input.lease);
        const ledger = await this.load(store.root);
        ledger.records = ledger.records.filter((r) => r.consumed || !sameLease(r.lease, lease));
        await this.save(store.root, ledger, options);
      },
      options,
    );
  }
}

function sameLease(left: MemoryLearningLease, right: MemoryLearningLease): boolean {
  return (
    left.workspaceKey === right.workspaceKey &&
    left.evidenceKey === right.evidenceKey &&
    left.token === right.token &&
    left.expiresAt === right.expiresAt
  );
}
