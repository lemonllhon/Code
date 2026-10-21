import { z } from "zod";
import { gitRepositoryRequestSchema } from "./gitPublish.js";
import { gitNetworkOperationSchema, gitIntegrationModeSchema } from "./gitNetwork.js";

const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const targetRef = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) ||
      (/^refs\/(?:heads|remotes|tags)\//.test(value) &&
        ![...value].some(
          (char) =>
            char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 || "~^:?*[\\".includes(char),
        ) &&
        !value.includes("..") &&
        !value.includes("@{") &&
        !value.endsWith(".") &&
        value.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"))),
  );
export const gitIntegrationPreviewRequestSchema = gitRepositoryRequestSchema
  .extend({
    mode: gitIntegrationModeSchema,
    targetRef,
    targets: z
      .array(oid)
      .min(1)
      .max(32)
      .refine((values) => new Set(values).size === values.length)
      .optional(),
    mainline: z.number().int().min(1).max(64).optional(),
  })
  .strict();
export const gitIntegrationPreviewSchema = z
  .object({
    root: z.string(),
    revision,
    mode: gitIntegrationModeSchema,
    targetRef,
    target: oid,
    head: oid,
    branch: z.string(),
    commitCount: z.number().int().nonnegative(),
    targets: z.array(oid).min(1).max(32).optional(),
    mainline: z.number().int().min(1).max(64).optional(),
  })
  .strict();
export const gitStartIntegrationRequestSchema = gitRepositoryRequestSchema
  .extend({
    requestId: z.string().min(1).max(128),
    preview: gitIntegrationPreviewSchema,
  })
  .strict();
export const gitIntegrationActionRequestSchema = gitRepositoryRequestSchema
  .extend({
    requestId: z.string().min(1).max(128),
    sourceRequestId: z.string().min(1).max(128),
    expectedRevision: revision,
    confirmNativeStopped: z.boolean(),
    confirmDiscard: z.boolean(),
  })
  .strict();
export const gitIntegrationSnapshotSchema = z
  .object({
    root: z.string(),
    revision,
    head: oid.nullable(),
    branch: z.string().nullable(),
    operation: gitNetworkOperationSchema.nullable(),
    blocked: z.boolean(),
    nativeMode: gitIntegrationModeSchema.nullable(),
    canContinue: z.boolean(),
    canAbort: z.boolean(),
    needsNativeConfirmation: z.boolean(),
    conflicts: z.array(z.string()),
    changedFiles: z.array(z.string()),
    progress: z.string().nullable(),
  })
  .strict();
export type GitIntegrationPreviewRequest = z.infer<typeof gitIntegrationPreviewRequestSchema>;
export type GitIntegrationPreview = z.infer<typeof gitIntegrationPreviewSchema>;
export type GitStartIntegrationRequest = z.infer<typeof gitStartIntegrationRequestSchema>;
export type GitIntegrationActionRequest = z.infer<typeof gitIntegrationActionRequestSchema>;
export type GitIntegrationSnapshot = z.infer<typeof gitIntegrationSnapshotSchema>;
