import { z } from "zod";
import { gitRepositoryRequestSchema } from "./gitPublish.js";
import { gitIntegrationPreviewRequestSchema } from "./gitIntegration.js";
import { gitConflictFileRequestSchema, gitConflictVersionSchema } from "./gitConflicts.js";
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  revision = z.string().regex(/^[a-f0-9]{64}$/);
const literal = z
  .string()
  .trim()
  .max(256)
  .refine((text) => !/[\r\n\0]/.test(text));
const date = z.string().datetime({ offset: true });
export const gitHistoryRequestSchema = gitRepositoryRequestSchema
  .extend({
    ref: gitIntegrationPreviewRequestSchema.shape.targetRef.optional(),
    author: literal.optional(),
    search: literal.optional(),
    searchMode: z.enum(["literal", "regex"]).optional(),
    caseSensitive: z.boolean().optional(),
    since: date.optional(),
    until: date.optional(),
    limit: z.number().int().min(1).max(100).default(50),
    skip: z.number().int().min(0).max(10000).default(0),
    expectedRevision: revision.optional(),
  })
  .strict()
  .refine((value) => !value.skip || Boolean(value.expectedRevision))
  .refine(
    (value) => !value.since || !value.until || Date.parse(value.since) <= Date.parse(value.until),
  );
export const gitHistoryPageSchema = z
  .object({
    revision,
    hasMore: z.boolean(),
    commits: z.array(
      z
        .object({
          hash: oid,
          parents: z.array(oid),
          subject: z.string(),
          authorName: z.string(),
          authoredAtMs: z.number(),
          refs: z.array(
            z
              .object({ name: z.string(), kind: z.enum(["branch", "remote", "tag", "head"]) })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();
export const gitHistoryDetailRequestSchema = gitRepositoryRequestSchema
  .extend({ hash: oid, parent: z.number().int().min(1).max(64).default(1) })
  .strict();
export const gitHistoryDetailSchema = z
  .object({
    hash: oid,
    parents: z.array(oid),
    parent: z.number().int(),
    parentHash: oid.nullable(),
    message: z.string(),
    authorName: z.string(),
    authorEmail: z.string(),
    authoredAtMs: z.number(),
    committerName: z.string(),
    committerEmail: z.string(),
    committedAtMs: z.number(),
    files: z.array(z.object({ path: z.string(), status: z.string() }).strict()),
    filesTruncated: z.boolean(),
  })
  .strict();
export const gitHistoryFileRequestSchema = gitHistoryDetailRequestSchema
  .extend({ path: gitConflictFileRequestSchema.shape.path })
  .strict();
export const gitHistoryFileSchema = z
  .object({ path: z.string(), before: gitConflictVersionSchema, after: gitConflictVersionSchema })
  .strict();
export const gitHistoryTagOptionsSchema = gitRepositoryRequestSchema
  .extend({
    hash: oid,
    name: z
      .string()
      .min(1)
      .max(255)
      .refine((name) => {
        const parsed = gitIntegrationPreviewRequestSchema.shape.targetRef.safeParse(
          `refs/tags/${name}`,
        );
        return parsed.success && !name.startsWith("refs/") && !name.startsWith("-");
      }),
    message: z
      .string()
      .trim()
      .min(1)
      .max(16384)
      .refine((text) => !text.includes("\0")),
    signed: z.boolean(),
  })
  .strict();
export const gitHistoryTagPreviewSchema = z
  .object({
    revision,
    root: z.string(),
    hash: oid,
    name: gitHistoryTagOptionsSchema.shape.name,
    message: gitHistoryTagOptionsSchema.shape.message,
    signed: z.boolean(),
    signer: z.string().nullable(),
  })
  .strict();
export const gitCreateHistoryTagRequestSchema = gitRepositoryRequestSchema
  .extend({ requestId: z.string().min(1).max(128), preview: gitHistoryTagPreviewSchema })
  .strict();
export const gitHistoryTagQuerySchema = gitRepositoryRequestSchema
  .extend({ name: gitHistoryTagOptionsSchema.shape.name })
  .strict();
export const gitHistoryTagInfoSchema = z
  .object({
    name: z.string(),
    oid: oid.nullable(),
    target: oid.nullable(),
    message: z.string().nullable(),
    hasSignature: z.boolean(),
  })
  .strict();
export type GitHistoryRequest = z.input<typeof gitHistoryRequestSchema>;
export type GitHistoryPage = z.infer<typeof gitHistoryPageSchema>;
export type GitHistoryDetailRequest = z.input<typeof gitHistoryDetailRequestSchema>;
export type GitHistoryDetail = z.infer<typeof gitHistoryDetailSchema>;
export type GitHistoryFileRequest = z.input<typeof gitHistoryFileRequestSchema>;
export type GitHistoryFile = z.infer<typeof gitHistoryFileSchema>;
export type GitHistoryTagOptions = z.infer<typeof gitHistoryTagOptionsSchema>;
export type GitHistoryTagPreview = z.infer<typeof gitHistoryTagPreviewSchema>;
export type GitCreateHistoryTagRequest = z.infer<typeof gitCreateHistoryTagRequestSchema>;
export type GitHistoryTagQuery = z.infer<typeof gitHistoryTagQuerySchema>;
export type GitHistoryTagInfo = z.infer<typeof gitHistoryTagInfoSchema>;

export const gitHistoryCandidatesSchema = z
  .object({
    revision,
    refs: z
      .array(
        z
          .object({
            value: gitIntegrationPreviewRequestSchema.shape.targetRef,
            label: z.string(),
            kind: z.enum(["head", "branch", "remote", "tag"]),
          })
          .strict(),
      )
      .max(500),
    authors: z
      .array(z.object({ name: z.string(), email: z.string(), value: literal }).strict())
      .max(200),
    refsTruncated: z.boolean(),
    authorsTruncated: z.boolean(),
    historyTruncated: z.boolean(),
  })
  .strict();
export type GitHistoryCandidates = z.infer<typeof gitHistoryCandidatesSchema>;
export const gitHistoryLocateRequestSchema = gitRepositoryRequestSchema
  .extend({
    target: z
      .string()
      .trim()
      .refine(
        (value) =>
          value === "HEAD" ||
          /^[a-f0-9]{4,64}$/i.test(value) ||
          gitIntegrationPreviewRequestSchema.shape.targetRef.safeParse(value).success,
      ),
  })
  .strict();
export const gitHistoryLocateResultSchema = z.object({ hash: oid }).strict();
export type GitHistoryLocateRequest = z.infer<typeof gitHistoryLocateRequestSchema>;
