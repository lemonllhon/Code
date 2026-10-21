import { z } from "zod";
import { gitRepositoryRequestSchema, gitPublishStateSchema } from "./gitPublish.js";

const name = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !/^[+-]/.test(value) &&
      !value.startsWith("refs/") &&
      value !== "@" &&
      ![...value].some(
        (character) =>
          character.charCodeAt(0) <= 32 ||
          character.charCodeAt(0) === 127 ||
          "~^:?*[\\".includes(character),
      ) &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !value.endsWith(".") &&
      value.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock")),
  );
const remoteName = name.refine((value) => !value.includes("/"));
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const url = z
  .string()
  .trim()
  .min(1)
  .max(8192)
  .refine(
    (value) =>
      !/^[+-]/.test(value) &&
      ![...value].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ),
  );
const command = gitRepositoryRequestSchema
  .extend({
    requestId: z.string().min(1).max(128),
    expectedRevision: revision,
  })
  .strict();
export const gitRemoteMutationRequestSchema = command
  .extend({
    action: z.enum(["add", "edit", "rename", "remove"]),
    name: remoteName,
    newName: remoteName.optional(),
    fetchUrls: z.array(url).min(1).max(16).optional(),
    pushUrls: z.array(url).max(16).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.action === "rename") !== Boolean(value.newName) ||
      (value.action === "add" || value.action === "edit") !== Boolean(value.fetchUrls) ||
      ((value.action === "remove" || value.action === "rename") && value.pushUrls !== undefined)
    )
      ctx.addIssue({ code: "custom", message: "Remote action fields do not match" });
  });
export const gitTrackingRequestSchema = command
  .extend({
    branch: name,
    upstream: z.object({ remote: remoteName, branch: name }).strict().nullable(),
  })
  .strict();
export const gitFetchRequestSchema = command
  .extend({
    remotes: z
      .array(remoteName)
      .min(1)
      .max(16)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict();
export const gitNetworkSnapshotSchema = z
  .object({
    revision,
    branch: z.string().nullable(),
    head: oid.nullable(),
    upstream: z.string().nullable(),
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
    remotes: z.array(
      z
        .object({
          name: z.string(),
          fetchUrls: z.array(z.string()),
          pushUrls: z.array(z.string()),
        })
        .strict(),
    ),
    branches: z.array(
      z
        .object({
          name: z.string(),
          head: oid,
          upstream: z.string().nullable(),
        })
        .strict(),
    ),
    remoteBranches: z.array(
      z.object({ remote: z.string(), branch: z.string(), head: oid }).strict(),
    ),
  })
  .strict();
export const gitFastForwardPreviewSchema = z
  .object({
    revision,
    state: gitPublishStateSchema.nullable(),
    branch: z.string().nullable(),
    head: oid.nullable(),
    upstream: z.string().nullable(),
    target: oid.nullable(),
    reason: z.enum([
      "ready",
      "up-to-date",
      "detached",
      "unborn",
      "no-upstream",
      "missing-upstream",
      "dirty",
      "operation-in-progress",
      "diverged",
      "unsupported",
    ]),
  })
  .strict();
export const gitFastForwardRequestSchema = command
  .extend({ preview: gitFastForwardPreviewSchema })
  .strict();
export const gitOperationQuerySchema = gitRepositoryRequestSchema
  .extend({ requestId: z.string().min(1).max(128) })
  .strict();
export const gitIntegrationModeSchema = z.enum(["merge", "rebase", "cherry-pick", "revert"]);
export type GitIntegrationMode = z.infer<typeof gitIntegrationModeSchema>;
export const gitHistoryResetMetadataSchema = z
  .object({
    mode: z.enum(["soft", "mixed", "hard"]),
    head: oid,
    target: oid,
    branch: z.string(),
    backupRef: z.string(),
    stashRef: z.string().nullable(),
    stashOid: oid.nullable(),
    beforeWorktree: revision,
    beforeIndex: revision,
    afterRevision: revision.optional(),
    restored: z.boolean().optional(),
  })
  .strict();
export const gitNetworkOperationSchema = z
  .object({
    unsettled: z.boolean().optional(),
    requestId: z.string(),
    kind: z.enum([
      "remote",
      "tracking",
      "fetch",
      "fast-forward",
      "repository-init",
      "repository-clone",
      "stash-save",
      "stash-apply",
      "stash-drop",
      "reconcile",
      "conflict-resolution",
      "conflict-save",
      "conflict-mark",
      "merge",
      "rebase",
      "cherry-pick",
      "revert",
      "history-tag",
      "history-reset",
      "history-reset-restore",
      "integration-continue",
      "integration-abort",
    ]),
    status: z.enum(["running", "success", "partial", "failed", "unknown", "conflict"]),
    targetPath: z.string().optional(),
    filePath: z.string().optional(),
    sourceRequestId: z.string().optional(),
    tagName: z.string().optional(),
    tagOid: oid.optional(),
    historyReset: gitHistoryResetMetadataSchema.optional(),
    integration: z
      .object({
        mode: gitIntegrationModeSchema,
        branch: z.string(),
        head: oid,
        target: oid,
        targets: z.array(oid).min(1).max(32).optional(),
        mainline: z.number().int().min(1).max(64).optional(),
      })
      .strict()
      .optional(),
    stashOid: oid.optional(),
    resolved: z.boolean().optional(),
    conflicts: z
      .array(
        z
          .object({
            path: z.string(),
            stages: z.array(
              z.object({ stage: z.number().int().min(1).max(3), oid, mode: z.string() }).strict(),
            ),
          })
          .strict(),
      )
      .optional(),
    startedAt: z.string(),
    finishedAt: z.string().optional(),
    code: z.string().optional(),
    before: oid.nullable().optional(),
    after: oid.nullable().optional(),
    results: z
      .array(
        z.object({ remote: z.string(), status: z.enum(["success", "failed", "unknown"]) }).strict(),
      )
      .optional(),
  })
  .strict();

export type GitNetworkSnapshot = z.infer<typeof gitNetworkSnapshotSchema>;
export type GitRemoteMutationRequest = z.infer<typeof gitRemoteMutationRequestSchema>;
export type GitTrackingRequest = z.infer<typeof gitTrackingRequestSchema>;
export type GitFetchRequest = z.infer<typeof gitFetchRequestSchema>;
export type GitFastForwardPreview = z.infer<typeof gitFastForwardPreviewSchema>;
export type GitFastForwardRequest = z.infer<typeof gitFastForwardRequestSchema>;
export type GitOperationQuery = z.infer<typeof gitOperationQuerySchema>;
export type GitNetworkOperation = z.infer<typeof gitNetworkOperationSchema>;
