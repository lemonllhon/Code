import { z } from "zod";
import { gitAccountAuthSchema, gitAccountProviderSchema } from "./gitManagement.js";
import { gitRepositoryRequestSchema } from "./gitPublish.js";
import { lcodeWorkspaceRefSchema } from "./lcode-protocol-legacy-types.js";
export const LCODE_GIT_CREDENTIAL_HELPER_COMMAND = "__lcode-git-credential-helper";

const url = z
  .string()
  .min(1)
  .max(8192)
  .refine((v) => ![...v].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127));
export const gitRepositoryAuthenticationRequestSchema = gitRepositoryRequestSchema.strict();
export const gitRepositoryAccountBindingSchema = gitRepositoryAuthenticationRequestSchema
  .extend({
    url,
    selection: z.string().min(1).max(1024).nullable(),
    expectedRevision: z.string().min(1).max(128),
  })
  .strict();
export const gitRepositoryAuthenticationSchema = z
  .object({
    revision: z.string(),
    choices: z.array(
      z
        .object({
          key: z.string(),
          name: z.string(),
          username: z.string(),
          serverUrl: z.string(),
          provider: gitAccountProviderSchema,
          auth: gitAccountAuthSchema,
        })
        .strict(),
    ),
    remotes: z.array(
      z
        .object({
          name: z.string(),
          urls: z.array(
            z.object({ url, selection: z.string().nullable(), stale: z.boolean() }).strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();

/** Host 私有 stdio 合同，认证结果不得进入公开 service channel 或会话事件。 */
export const gitCredentialRequestSchema = z
  .object({
    workspace: lcodeWorkspaceRefSchema,
    sessionId: z.string().min(1).max(200),
    cwd: z.string().min(1).max(8192),
    url,
    transport: z.enum(["http", "ssh"]),
  })
  .strict();
const privateText = z
  .string()
  .max(16384)
  .refine((v) => ![...v].some((char) => [0, 10, 13].includes(char.charCodeAt(0))));
export const gitCredentialResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("http"), username: privateText, password: privateText }).strict(),
  z.object({ kind: z.literal("ssh"), username: privateText, privateKeyPath: privateText }).strict(),
  z.object({ kind: z.literal("error"), error: z.string().regex(/^git-[a-z-]+$/) }).strict(),
]);
export type GitRepositoryAuthenticationRequest = z.infer<
  typeof gitRepositoryAuthenticationRequestSchema
>;
export type GitRepositoryAccountBinding = z.infer<typeof gitRepositoryAccountBindingSchema>;
export type GitRepositoryAuthentication = z.infer<typeof gitRepositoryAuthenticationSchema>;
export type GitCredentialRequest = z.infer<typeof gitCredentialRequestSchema>;
export type GitCredentialResult = z.infer<typeof gitCredentialResultSchema>;
