import { z } from "zod";
import { gitRepositoryRequestSchema } from "./gitPublish.js";
import { gitHistoryDetailRequestSchema } from "./gitHistory.js";
import { gitHistoryResetMetadataSchema } from "./gitNetwork.js";
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const gitHistoryResetOptionsSchema = gitRepositoryRequestSchema
  .extend({
    target: gitHistoryDetailRequestSchema.shape.hash,
    mode: z.enum(["soft", "mixed", "hard"]),
  })
  .strict();
export const gitHistoryResetPreviewSchema = z
  .object({
    root: z.string(),
    revision,
    head: gitHistoryDetailRequestSchema.shape.hash,
    branch: z.string(),
    target: gitHistoryDetailRequestSchema.shape.hash,
    mode: z.enum(["soft", "mixed", "hard"]),
    trackedChanges: z.boolean(),
    recovery: gitHistoryResetMetadataSchema.optional(),
    sourceRequestId: z.string().min(1).max(128).optional(),
  })
  .strict();
export const gitHistoryResetRequestSchema = gitRepositoryRequestSchema
  .extend({
    requestId: z.string().min(1).max(128),
    preview: gitHistoryResetPreviewSchema,
    confirmDiscard: z.boolean(),
  })
  .strict();
export type GitHistoryResetOptions = z.infer<typeof gitHistoryResetOptionsSchema>;
export type GitHistoryResetPreview = z.infer<typeof gitHistoryResetPreviewSchema>;
export type GitHistoryResetRequest = z.infer<typeof gitHistoryResetRequestSchema>;
