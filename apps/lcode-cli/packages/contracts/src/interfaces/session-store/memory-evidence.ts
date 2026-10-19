import { z } from "zod";
import type { SessionId } from "../shared.js";
import type { SessionInfo } from "./session-records.js";

export const MemoryExtractionRetryInputSchema = z
  .object({
    startMessageId: z.string().min(1).max(256),
    boundaryMessageId: z.string().min(1).max(256),
    turnId: z.string().min(1).max(256),
  })
  .strict();
export type MemoryExtractionRetryInput = z.infer<typeof MemoryExtractionRetryInputSchema>;

export const MemoryEvidenceCursorSchema = z
  .object({
    messageId: z.string().min(1).max(256),
    partId: z.string().min(1).max(256),
    offset: z.number().int().nonnegative().safe(),
    inclusive: z.boolean().optional(),
    afterMessage: z.boolean().optional(),
    selection: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type MemoryEvidenceCursor = z.infer<typeof MemoryEvidenceCursorSchema>;
export const ReadMemoryReviewEvidenceSchema = z
  .object({
    sessionID: z.string().min(1).max(256),
    startMessageID: z.string().min(1).max(256).optional(),
    throughMessageID: z.string().min(1).max(256),
    turnId: z.string().min(1).max(256).optional(),
    cursor: MemoryEvidenceCursorSchema.optional(),
    maxCharacters: z.number().int().min(256).max(65_536),
    memoryScope: z
      .object({ rootDir: z.string().min(1), workingDirectory: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();
export type ReadMemoryReviewEvidenceInput = Omit<
  z.infer<typeof ReadMemoryReviewEvidenceSchema>,
  "sessionID"
> & {
  sessionID: SessionId;
  signal?: AbortSignal;
};
export interface MemoryReviewEvidencePage {
  session: SessionInfo | null;
  status: "ready" | "unavailable";
  reason?:
    | "missing-boundary"
    | "branch-unprovable"
    | "no-user-prose"
    | "foreground-review"
    | "stale-source"
    | "direct-memory-write";
  startMessageID: string;
  throughMessageID: string;
  selection: string;
  content: string;
  nextCursor?: MemoryEvidenceCursor;
  projectedRows: number;
}

export const MemoryReviewEvidencePageSchema = z
  .object({
    session: z.custom<SessionInfo | null>(
      (value) =>
        value === null ||
        (typeof value === "object" &&
          value !== null &&
          "id" in value &&
          "directory" in value &&
          "time" in value),
    ),
    status: z.enum(["ready", "unavailable"]),
    reason: z
      .enum([
        "missing-boundary",
        "branch-unprovable",
        "no-user-prose",
        "foreground-review",
        "stale-source",
        "direct-memory-write",
      ])
      .optional(),
    startMessageID: z.string().max(256),
    throughMessageID: z.string().min(1).max(256),
    selection: z.string().regex(/^(?:[a-f0-9]{64})?$/u),
    content: z.string().max(65_536),
    nextCursor: MemoryEvidenceCursorSchema.optional(),
    projectedRows: z.number().int().min(0).max(128),
  })
  .strict()
  .superRefine((page, context) => {
    if (
      (page.status === "ready" &&
        (!page.session || !page.startMessageID || !page.selection || page.reason)) ||
      (page.status === "unavailable" && (page.content || page.nextCursor || !page.reason))
    )
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid evidence page state" });
  });
