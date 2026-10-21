import { z } from "zod";
import { gitRepositoryRequestSchema } from "./gitPublish.js";
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const path = z
  .string()
  .min(1)
  .max(8192)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes(":") &&
      !value.includes("\0") &&
      !value.includes("\ufffd") &&
      !value
        .split("/")
        .some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git"),
  );
export const gitConflictStageSchema = z
  .object({ stage: z.number().int().min(1).max(3), oid, mode: z.string().regex(/^[0-7]{6}$/) })
  .strict();
export const gitConflictEntrySchema = z
  .object({
    path,
    stages: z.array(gitConflictStageSchema),
    kind: z.enum(["both-modified", "both-added", "deleted-by-us", "deleted-by-them", "complex"]),
  })
  .strict();
export const gitConflictSnapshotSchema = z
  .object({
    root: z.string(),
    revision,
    operation: z.enum(["stash", "merge", "rebase", "cherry-pick", "revert", "index"]),
    sourceRequestId: z.string().nullable(),
    blocked: z.boolean(),
    nativeCheck: z.boolean(),
    files: z.array(gitConflictEntrySchema),
  })
  .strict();
export const gitConflictVersionSchema = z
  .object({
    kind: z.enum([
      "absent",
      "text",
      "binary",
      "encoding",
      "large",
      "symlink",
      "submodule",
      "directory",
    ]),
    oid: oid.nullable(),
    mode: z.string().nullable(),
    size: z.number().int().nonnegative(),
    text: z.string().nullable(),
    eol: z.enum(["lf", "crlf", "mixed", "none"]),
  })
  .strict();
export const gitConflictFileRequestSchema = gitRepositoryRequestSchema.extend({ path }).strict();
export const gitConflictFileSchema = z
  .object({
    path,
    revision,
    entry: gitConflictEntrySchema,
    base: gitConflictVersionSchema,
    ours: gitConflictVersionSchema,
    theirs: gitConflictVersionSchema,
    result: gitConflictVersionSchema,
    editable: z.boolean(),
    canMark: z.boolean(),
    hasMarkers: z.boolean(),
  })
  .strict();
export const gitBeginConflictRequestSchema = gitRepositoryRequestSchema
  .extend({ requestId: z.string().min(1).max(128), expectedRevision: revision })
  .strict();
const command = gitConflictFileRequestSchema
  .extend({
    requestId: z.string().min(1).max(128),
    sourceRequestId: z.string().min(1).max(128),
    expectedRevision: revision,
    confirmNativeStopped: z.boolean(),
  })
  .strict();
export const gitSaveConflictRequestSchema = command
  .extend({
    action: z.enum(["save", "delete"]),
    text: z
      .string()
      .max(256 * 1024)
      .refine((text) => !text.includes("\0"))
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.action === "save") !== (value.text !== undefined))
      ctx.addIssue({ code: "custom", message: "Result text must match save action" });
  });
export const gitMarkConflictRequestSchema = command
  .extend({ confirmSpecial: z.boolean() })
  .strict();
export type GitConflictSnapshot = z.infer<typeof gitConflictSnapshotSchema>;
export type GitConflictEntry = z.infer<typeof gitConflictEntrySchema>;
export type GitConflictVersion = z.infer<typeof gitConflictVersionSchema>;
export type GitConflictFile = z.infer<typeof gitConflictFileSchema>;
export type GitConflictFileRequest = z.infer<typeof gitConflictFileRequestSchema>;
export type GitBeginConflictRequest = z.infer<typeof gitBeginConflictRequestSchema>;
export type GitSaveConflictRequest = z.infer<typeof gitSaveConflictRequestSchema>;
export type GitMarkConflictRequest = z.infer<typeof gitMarkConflictRequestSchema>;
