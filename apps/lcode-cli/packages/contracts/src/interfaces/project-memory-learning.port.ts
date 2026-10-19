import { z } from "zod";
import type { ProjectMemoryOperationOptions } from "./project-memory.port.js";

export const MEMORY_LEARNING_RECORD_LIMIT = 2048;
export const MEMORY_LEARNING_BYTES_LIMIT = 1024 * 1024;
export const MEMORY_LEARNING_LEASE_MS = 180_000;
export const MEMORY_LEARNING_REQUEST_MS = 120_000;

export const MemoryLearningLeaseSchema = z
  .object({
    workspaceKey: z.string().min(1).max(4096),
    evidenceKey: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    token: z.string().uuid(),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();
export type MemoryLearningLease = z.infer<typeof MemoryLearningLeaseSchema>;

const MemoryLearningRecordSchema = z
  .object({
    workspaceKey: MemoryLearningLeaseSchema.shape.workspaceKey,
    evidenceKey: MemoryLearningLeaseSchema.shape.evidenceKey,
    lease: MemoryLearningLeaseSchema,
    consumed: z.boolean(),
  })
  .strict()
  .refine((r) => r.workspaceKey === r.lease.workspaceKey && r.evidenceKey === r.lease.evidenceKey);
export const MemoryLearningLedgerSchema = z
  .object({
    schemaVersion: z.literal(1),
    rootDir: z.string(),
    records: z.array(MemoryLearningRecordSchema).max(MEMORY_LEARNING_RECORD_LIMIT),
  })
  .strict();
export type MemoryLearningLedger = z.infer<typeof MemoryLearningLedgerSchema>;

/** The content adapter owns claims under its existing root writer lock. */
export interface ProjectMemoryLearningPort {
  claim(
    input: {
      rootDir: string;
      workspaceKey: string;
      evidenceKey: string;
    },
    options?: ProjectMemoryOperationOptions,
  ): Promise<
    { status: "claimed"; lease: MemoryLearningLease } | { status: "consumed" | "busy" | "full" }
  >;
  finish(
    input: { rootDir: string; lease: MemoryLearningLease },
    options?: ProjectMemoryOperationOptions,
  ): Promise<void>;
  release(
    input: { rootDir: string; lease: MemoryLearningLease },
    options?: ProjectMemoryOperationOptions,
  ): Promise<void>;
}
