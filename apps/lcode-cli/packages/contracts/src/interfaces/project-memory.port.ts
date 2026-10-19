import { z } from "zod";
import { MemoryEvidenceCursorSchema } from "./session-store/memory-evidence.js";
import type { TraceContext } from "../tracing/tracer.js";
import type { ProjectMemoryEffectPort } from "./project-memory-effects.port.js";
import type {
  MemoryLearningLease,
  ProjectMemoryLearningPort,
} from "./project-memory-learning.port.js";
export * from "./project-memory-effects.port.js";
export * from "./project-memory-learning.port.js";

export const PROJECT_MEMORY_FILE_MAX_BYTES = 256 * 1024;
export const PROJECT_MEMORY_RECORD_MAX_BYTES = 1024 * 1024;
export const PROJECT_MEMORY_RECORD_LIMIT = 100;
export const PROJECT_MEMORY_PREIMAGES_MAX_BYTES = 20 * 1024 * 1024;
export const PROJECT_MEMORY_REVIEW_ITEM_LIMIT = 10;
export const PROJECT_MEMORY_REVIEW_TOTAL_CHARACTERS = 64_000;

const recordId = z.string().regex(/^[a-zA-Z0-9_-]{8,96}$/u);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const relativeMarkdownPath = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      value.endsWith(".md") &&
      !value.includes("\\") &&
      !value.includes(":") &&
      !Array.from(value).some((character) => character.charCodeAt(0) < 32) &&
      value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
    "Expected a contained relative Markdown path",
  );

export const ProjectMemoryReviewSourceSchema = z
  .object({
    id: z.string().min(1).max(128),
    kind: z.enum(["session", "memory"]),
    reference: z.string().min(1).max(256),
    revision: z.string().min(1).max(256),
    boundaryMessageId: z.string().min(1).max(256).optional(),
    projection: z.enum(["latest-turn", "completed-turn-v2"]).optional(),
    segment: z
      .object({
        startMessageID: z.string().min(1).max(256),
        turnId: z.string().min(1).max(256).optional(),
        cursor: MemoryEvidenceCursorSchema.optional(),
        previous: z.object({ cursor: MemoryEvidenceCursorSchema.optional() }).strict().optional(),
        maxCharacters: z.number().int().min(256).max(65_536),
      })
      .strict()
      .optional(),
    memoryRange: z
      .object({ offset: z.number().int().nonnegative(), length: z.number().int().nonnegative() })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((source, context) => {
    if (
      source.kind !== "session" &&
      (source.boundaryMessageId !== undefined || source.projection !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Only session evidence has a message boundary",
      });
    }
    if (source.projection && !source.boundaryMessageId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Latest-turn evidence requires a fixed end boundary",
      });
    }
    if ((source.projection === "completed-turn-v2") !== Boolean(source.segment))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Versioned evidence requires its segment selector",
      });
    if (source.memoryRange && source.kind !== "memory")
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Only memory content has byte ranges",
      });
  });

export const ProjectMemoryReviewItemSchema = z
  .object({
    id: recordId,
    fileName: relativeMarkdownPath,
    expectedHash: hash.nullable(),
    content: z.string().min(1),
    range: z
      .object({ offset: z.number().int().nonnegative(), length: z.number().int().nonnegative() })
      .strict()
      .optional(),
    reason: z.string().min(1).max(2000),
    sourceIds: z.array(z.string().min(1).max(128)).min(1).max(16),
  })
  .strict();

export const ProjectMemoryReviewDraftSchema = z
  .object({
    fingerprint: hash,
    sources: z.array(ProjectMemoryReviewSourceSchema).max(64),
    items: z.array(ProjectMemoryReviewItemSchema).max(PROJECT_MEMORY_REVIEW_ITEM_LIMIT),
    partial: z.boolean(),
    summary: z.string().max(4000),
  })
  .strict()
  .superRefine((value, context) => {
    const sources = new Set(value.sources.map((source) => source.id));
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const item of value.items) {
      if (
        ids.has(item.id) ||
        paths.has(item.fileName) ||
        item.sourceIds.some((id) => !sources.has(id))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Review contains duplicate targets or unknown evidence",
        });
      }
      ids.add(item.id);
      paths.add(item.fileName);
    }
  });

export type ProjectMemoryReviewSource = z.infer<typeof ProjectMemoryReviewSourceSchema>;
export type ProjectMemoryReviewItem = z.infer<typeof ProjectMemoryReviewItemSchema>;
export type ProjectMemoryReviewDraft = z.infer<typeof ProjectMemoryReviewDraftSchema>;

export const ProjectMemoryVerificationSchema = z
  .object({
    acceptedItemIds: z.array(recordId).max(PROJECT_MEMORY_REVIEW_ITEM_LIMIT),
    rankingEligibleItemIds: z.array(recordId).max(PROJECT_MEMORY_REVIEW_ITEM_LIMIT).optional(),
    reasons: z
      .array(z.object({ itemId: recordId, reason: z.string().max(2000) }).strict())
      .max(PROJECT_MEMORY_REVIEW_ITEM_LIMIT),
  })
  .strict();
export type ProjectMemoryVerification = z.infer<typeof ProjectMemoryVerificationSchema>;

export const ProjectMemoryReviewSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: recordId,
    createdAt: z.number().int().nonnegative(),
    revision: z.number().int().positive(),
    draft: ProjectMemoryReviewDraftSchema,
    verification: ProjectMemoryVerificationSchema.optional(),
    appliedItems: z.record(recordId, recordId),
  })
  .strict();
export type ProjectMemoryReview = z.infer<typeof ProjectMemoryReviewSchema>;

export const ProjectMemoryReviewSummarySchema = z
  .object({
    id: recordId,
    createdAt: z.number().int().nonnegative(),
    revision: z.number().int().positive(),
    itemCount: z.number().int().nonnegative(),
    appliedCount: z.number().int().nonnegative(),
    partial: z.boolean(),
    summary: z.string().max(4000),
  })
  .strict();
export type ProjectMemoryReviewSummary = z.infer<typeof ProjectMemoryReviewSummarySchema>;
export const ProjectMemoryHistoryPageInputSchema = z
  .object({
    rootDir: z.string().min(1),
    kind: z.enum(["changes", "reviews"]),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export type ProjectMemoryHistoryPageInput = z.infer<typeof ProjectMemoryHistoryPageInputSchema>;

export const ProjectMemoryChangeSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: recordId,
    fileName: relativeMarkdownPath,
    createdAt: z.number().int().nonnegative(),
    beforeHash: hash.nullable(),
    afterHash: hash,
    replacementHash: hash.optional(),
    status: z.enum(["prepared", "committed", "not-committed", "recovery-required"]),
    sessionId: z.string().optional(),
    undoOf: recordId.optional(),
    proposalId: recordId.optional(),
    proposalItemId: recordId.optional(),
  })
  .strict();
export type ProjectMemoryChange = z.infer<typeof ProjectMemoryChangeSchema>;

export interface ProjectMemoryOperationOptions {
  signal?: AbortSignal;
  trace?: TraceContext;
}

export interface ProjectMemoryPort {
  /** 完整消费才构成成功的全文读取；固定内存流，结束时校验完整 hash 和文件身份。 */
  iterateContentPages?(
    input: { rootDir: string; fileName: string; maxBytes: number },
    options?: ProjectMemoryOperationOptions,
  ): AsyncIterable<Awaited<ReturnType<NonNullable<ProjectMemoryPort["readContentPage"]>>>>;
  listHistoryPage?(
    input: ProjectMemoryHistoryPageInput,
    options?: ProjectMemoryOperationOptions,
  ): Promise<
    | { kind: "changes"; changes: ProjectMemoryChange[]; nextCursor?: string }
    | { kind: "reviews"; proposals: ProjectMemoryReviewSummary[]; nextCursor?: string }
  >;
  /** UTF-8 安全边界页；hash 覆盖完整原始文件，续读须提交 expectedHash。 */
  readContentPage?(
    input: {
      rootDir: string;
      fileName: string;
      offset?: number;
      maxBytes: number;
      expectedHash?: string;
    },
    options?: ProjectMemoryOperationOptions,
  ): Promise<{
    content: string;
    hash: string;
    offset: number;
    bytesRead: number;
    sizeBytes: number;
    nextOffset?: number;
  }>;
  /** Prepare/copy a storage location through the shared writer locks; no governance state is copied. */
  prepareStorage?(input: {
    cliStorageRoot: string;
    workspacePath: string;
    workspaceIdentity?: string;
    storageLocation: "profile" | "workspace";
    storageRevision?: number;
    previousStorageLocation?: "profile" | "workspace";
  }): Promise<{ rootDir: string; copiedCount: number; conflictCount: number }>;
  /** Optional bounded observation capability; content writes remain on this port. */
  effects?: ProjectMemoryEffectPort;
  learning?: ProjectMemoryLearningPort;
  registerRoot(rootDir: string): Promise<void>;
  inspectCapacity(
    rootDir: string,
    options?: ProjectMemoryOperationOptions,
  ): Promise<{
    available: boolean;
    reason?: "history-full" | "reviews-full" | "preimages-full" | "recovery-required";
  }>;
  listChanges(
    rootDir: string,
    options?: ProjectMemoryOperationOptions,
  ): Promise<ProjectMemoryChange[]>;
  previewUndo(
    input: { rootDir: string; changeId: string; offset?: number; maxBytes?: number },
    options?: ProjectMemoryOperationOptions,
  ): Promise<{ change: ProjectMemoryChange; content: string; nextOffset?: number }>;
  undoChange(
    input: { rootDir: string; changeId: string; expectedHash: string; expectedBeforeHash: string },
    options?: ProjectMemoryOperationOptions,
  ): Promise<ProjectMemoryChange>;
  saveReview(
    input: {
      rootDir: string;
      draft: ProjectMemoryReviewDraft;
      verification?: ProjectMemoryVerification;
    },
    options?: ProjectMemoryOperationOptions,
  ): Promise<ProjectMemoryReview>;
  readReview(
    input: { rootDir: string; proposalId: string },
    options?: ProjectMemoryOperationOptions,
  ): Promise<ProjectMemoryReview>;
  listReviews(
    rootDir: string,
    options?: ProjectMemoryOperationOptions,
  ): Promise<ProjectMemoryReview[]>;
  applyReview(
    input: {
      rootDir: string;
      proposalId: string;
      revision: number;
      itemId: string;
      expectedItemHash: string;
      expectedSourceHashes: ReadonlyArray<{ fileName: string; hash: string }>;
      learningLease?: MemoryLearningLease;
    },
    options?: ProjectMemoryOperationOptions,
  ): Promise<ProjectMemoryChange>;
}
