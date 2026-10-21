import { z } from "zod";
import { lcodeWorkspaceRefSchema } from "./lcode-protocol-legacy-types.js";
import { gitAccountProviderSchema } from "./gitManagement.js";

const text = z
  .string()
  .max(8192)
  .refine((v) => ![...v].some((c) => c.charCodeAt(0) < 32));
const publicUrl = text.refine((value) => {
  if (!value.includes("://")) return true;
  try {
    const parsed = new URL(value);
    return !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
});
export const gitAgentContextRequestSchema = z.strictObject({
  workspace: lcodeWorkspaceRefSchema,
  sessionId: z.string().min(1).max(200),
});
export const gitAgentRepositoryContextSchema = z.strictObject({
  workspacePath: text,
  revision: z.string().max(128).nullable(),
  status: z.enum(["available", "unavailable"]),
  partial: z.boolean(),
  remotes: z
    .array(
      z.strictObject({
        name: text,
        url: publicUrl,
        authentication: z.strictObject({
          status: z.enum([
            "selected",
            "automatic",
            "selection-required",
            "stale",
            "system-default",
            "not-applicable",
          ]),
          account: z
            .strictObject({ name: text, username: text, provider: gitAccountProviderSchema })
            .optional(),
        }),
      }),
    )
    .max(32),
});
export const gitAgentContextSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("available"),
    partial: z.boolean(),
    repositories: z.array(gitAgentRepositoryContextSchema).max(20),
  }),
  z.strictObject({ status: z.literal("unavailable") }),
]);
export type GitAgentContextRequest = z.infer<typeof gitAgentContextRequestSchema>;
export type GitAgentRepositoryContext = z.infer<typeof gitAgentRepositoryContextSchema>;
export type GitAgentContext = z.infer<typeof gitAgentContextSchema>;
