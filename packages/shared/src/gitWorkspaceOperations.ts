import { z } from "zod";
import { gitAuthenticationReferenceSchema } from "./gitManagement.js";
import {
  gitRepositoryRequestSchema,
  gitPublishStateSchema,
  gitCreateTagRequestSchema,
} from "./gitPublish.js";
import { gitNetworkOperationSchema } from "./gitNetwork.js";

const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const request = gitRepositoryRequestSchema
  .extend({ requestId: z.string().min(1).max(128) })
  .strict();
const leaf = z
  .string()
  .min(1)
  .max(100)
  .refine(
    (value) =>
      !/[<>:"/\\|?*]/.test(value) &&
      ![...value].some((char) => char.charCodeAt(0) < 32) &&
      value !== "." &&
      value !== ".." &&
      !/[ .]$/.test(value) &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value),
  );
export const gitAcquisitionOptionsSchema = gitRepositoryRequestSchema
  .extend({
    mode: z.enum(["init", "clone"]),
    targetName: leaf.optional(),
    url: z
      .string()
      .trim()
      .min(1)
      .max(8192)
      .refine(
        (value) => !value.startsWith("-") && ![...value].some((char) => char.charCodeAt(0) < 32),
      )
      .optional(),
    initialBranch: gitCreateTagRequestSchema.shape.name.optional(),
    allowNested: z.boolean().optional(),
    authentication: gitAuthenticationReferenceSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.mode === "clone"
        ? !value.url || !value.targetName || value.initialBranch !== undefined
        : value.url !== undefined ||
          value.targetName !== undefined ||
          value.authentication !== undefined
    )
      ctx.addIssue({ code: "custom", message: "Acquisition fields do not match the mode" });
  });
export const gitAcquisitionPreviewSchema = z
  .object({
    revision,
    targetPath: z.string(),
    parentRepository: z.string().nullable(),
    mode: z.enum(["init", "clone"]),
  })
  .strict();
export const gitAcquireRepositoryRequestSchema = z
  .object({
    options: gitAcquisitionOptionsSchema,
    requestId: z.string().min(1).max(128),
    preview: gitAcquisitionPreviewSchema,
  })
  .strict();
export const gitStashEntrySchema = z
  .object({
    oid,
    selector: z.string().regex(/^stash@\{\d+\}$/),
    subject: z.string(),
    timestamp: z.number().int(),
  })
  .strict();
export const gitStashSnapshotSchema = z
  .object({
    revision,
    entries: z.array(gitStashEntrySchema),
    blocked: z.boolean(),
    operation: gitNetworkOperationSchema.nullable(),
  })
  .strict();
export const gitStashSelectionSchema = gitRepositoryRequestSchema
  .extend({ oid, expectedRevision: revision })
  .strict();
export const gitStashPreviewSchema = z
  .object({
    oid,
    revision,
    sections: z.array(
      z
        .object({
          source: z.enum(["staged", "unstaged", "untracked"]),
          patch: z.string(),
          truncated: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
export const gitStashSavePreviewRequestSchema = gitRepositoryRequestSchema
  .extend({ includeUntracked: z.boolean() })
  .strict();
export const gitStashSavePreviewSchema = z
  .object({
    root: z.string(),
    files: z.array(z.string()),
    expectedState: gitPublishStateSchema,
    revision,
  })
  .strict();
export const gitStashSaveRequestSchema = request
  .extend({
    expectedRevision: revision,
    expectedState: gitPublishStateSchema,
    includeUntracked: z.boolean(),
    message: z.string().trim().max(1024),
  })
  .strict();
export const gitStashApplyRequestSchema = gitStashSelectionSchema
  .extend({
    requestId: z.string().min(1).max(128),
    expectedState: gitPublishStateSchema,
    restoreIndex: z.boolean(),
  })
  .strict();
export const gitStashDropRequestSchema = gitStashSelectionSchema
  .extend({ requestId: z.string().min(1).max(128), selector: gitStashEntrySchema.shape.selector })
  .strict();
export const gitCompleteOperationPreviewSchema = z
  .object({
    sourceRequestId: z.string(),
    targetPath: z.string(),
    revision,
    conflicts: z.array(z.string()),
    canComplete: z.boolean(),
    needsNativeConfirmation: z.boolean(),
  })
  .strict();
export const gitCompleteOperationRequestSchema = request
  .extend({
    sourceRequestId: z.string().min(1).max(128),
    expectedRevision: revision,
    confirmNativeStopped: z.boolean(),
  })
  .strict();
export type GitAcquisitionOptions = z.infer<typeof gitAcquisitionOptionsSchema>;
export type GitAcquisitionPreview = z.infer<typeof gitAcquisitionPreviewSchema>;
export type GitAcquireRepositoryRequest = z.infer<typeof gitAcquireRepositoryRequestSchema>;
export type GitStashSnapshot = z.infer<typeof gitStashSnapshotSchema>;
export type GitStashEntry = z.infer<typeof gitStashEntrySchema>;
export type GitStashPreview = z.infer<typeof gitStashPreviewSchema>;
export type GitStashSelection = z.infer<typeof gitStashSelectionSchema>;
export type GitStashSaveRequest = z.infer<typeof gitStashSaveRequestSchema>;
export type GitStashSavePreviewRequest = z.infer<typeof gitStashSavePreviewRequestSchema>;
export type GitStashSavePreview = z.infer<typeof gitStashSavePreviewSchema>;
export type GitStashApplyRequest = z.infer<typeof gitStashApplyRequestSchema>;
export type GitStashDropRequest = z.infer<typeof gitStashDropRequestSchema>;
export type GitCompleteOperationPreview = z.infer<typeof gitCompleteOperationPreviewSchema>;
export type GitCompleteOperationRequest = z.infer<typeof gitCompleteOperationRequestSchema>;
