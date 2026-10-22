import { z } from "zod";
import { lcodeWorkspaceRefSchema } from "./lcode-protocol-legacy-types.js";
import { gitAgentRepositoryContextSchema } from "./gitAgentContext.js";
import { gitAccountProviderSchema, gitAccountAuthSchema } from "./gitManagement.js";

const text = z
  .string()
  .trim()
  .min(1)
  .max(8192)
  .refine((s) => !/[\r\n\0]/.test(s));
export const gitAccountOperationSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("inspect"), cwd: text, url: text }),
  z.strictObject({
    action: z.literal("bind"),
    cwd: text,
    url: text,
    username: text,
    auth: gitAccountAuthSchema.optional(),
    expectedRevision: text,
  }),
]);
export const gitAccountOperationRequestSchema = z.strictObject({
  workspace: lcodeWorkspaceRefSchema,
  sessionId: text,
  operation: gitAccountOperationSchema,
});
export const gitAccountOperationResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ok"),
    revision: text,
    choices: z
      .array(
        z.strictObject({
          username: text,
          auth: gitAccountAuthSchema,
          provider: gitAccountProviderSchema,
        }),
      )
      .max(200),
    repository: gitAgentRepositoryContextSchema,
  }),
  z.strictObject({
    status: z.literal("error"),
    error: z.enum([
      "git-account-scope-unavailable",
      "git-account-selection-unavailable",
      "git-account-selection-required",
      "git-account-binding-conflict",
      "git-account-remote-changed",
      "git-account-binding-stale",
      "git-account-repository-unavailable",
    ]),
  }),
]);
export type GitAccountOperation = z.infer<typeof gitAccountOperationSchema>;
export type GitAccountOperationRequest = z.infer<typeof gitAccountOperationRequestSchema>;
export type GitAccountOperationResult = z.infer<typeof gitAccountOperationResultSchema>;
