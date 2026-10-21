import { z } from "zod";

const text = z
  .string()
  .trim()
  .max(512)
  .refine((v) => ![...v].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127));
export const gitAccountProviderSchema = z.enum(["github", "gitlab", "gitea", "server"]);
export const gitAccountAuthSchema = z.enum(["token", "ssh", "system", "oauth"]);
export const gitServerUrlSchema = text.min(1).refine((value) => {
  try {
    const url = new URL(value);
    return (
      ["https:", "http:", "ssh:"].includes(url.protocol) &&
      Boolean(url.hostname) &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === "ssh:" || !url.username)
    );
  } catch {
    return false;
  }
}, "Expected a server URL without credentials");
export const gitConfigurationSchema = z
  .object({
    binaryPath: text,
    userName: text,
    userEmail: text,
    initialBranch: text
      .min(1)
      .max(100)
      .refine(
        (v) =>
          !v.startsWith("-") &&
          !/[\s~^:?*[\\]/.test(v) &&
          !v.includes("..") &&
          !v.includes("@{") &&
          !v.endsWith(".") &&
          !v.endsWith("/") &&
          !v.endsWith(".lock"),
      ),
  })
  .strict();
export const gitAccountInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: text.min(1),
    provider: gitAccountProviderSchema,
    serverUrl: gitServerUrlSchema,
    username: text.min(1),
    auth: gitAccountAuthSchema,
    privateKeyPath: text.default(""),
    token: z
      .string()
      .max(16384)
      .refine((v) => ![...v].some((char) => [0, 10, 13].includes(char.charCodeAt(0))))
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    let protocol: string;
    try {
      protocol = new URL(v.serverUrl).protocol;
    } catch {
      return;
    }
    if ((v.auth === "ssh") !== (protocol === "ssh:"))
      ctx.addIssue({ code: "custom", message: "SSH accounts require an SSH server URL" });
    if (v.auth !== "token" && v.token)
      ctx.addIssue({ code: "custom", message: "Tokens require token authentication" });
  });
export const gitAccountSchema = z
  .object({
    id: z.string().uuid(),
    revision: z.string().uuid(),
    name: text.min(1),
    provider: gitAccountProviderSchema,
    serverUrl: gitServerUrlSchema,
    username: text.min(1),
    auth: gitAccountAuthSchema,
    privateKeyPath: text,
    hasToken: z.boolean(),
  })
  .strict();
export const gitAuthenticationReferenceSchema = z
  .object({ id: z.string().uuid(), revision: z.string().uuid() })
  .strict();
export const gitManagementSnapshotSchema = z
  .object({
    revision: z.string(),
    configuration: gitConfigurationSchema,
    accounts: z.array(gitAccountSchema).max(200),
  })
  .strict();
export const gitManagementMutationSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("authorize"),
      expectedRevision: z.string(),
      requestId: z.string().uuid(),
      name: text.min(1),
      accountId: z.string().uuid().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("configuration"),
      expectedRevision: z.string(),
      configuration: gitConfigurationSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("save"),
      expectedRevision: z.string(),
      account: gitAccountInputSchema,
    })
    .strict(),
  z
    .object({ type: z.literal("delete"), expectedRevision: z.string(), id: z.string().uuid() })
    .strict(),
  z
    .object({
      type: z.literal("import"),
      expectedRevision: z.string(),
      candidateId: z.string().min(1).max(512),
    })
    .strict(),
]);
export const gitDetectedAccountSchema = gitAccountSchema
  .omit({ id: true, revision: true, hasToken: true })
  .extend({ candidateId: z.string(), source: z.string(), canImport: z.boolean() })
  .strict();
export const gitDetectedSshKeySchema = z
  .object({
    privateKeyPath: z.string().min(1).max(4096),
    publicKeyPath: z.string().max(4096),
    keyType: z.string().max(100).nullable(),
    fingerprint: z.string().max(100).nullable(),
    publicKey: z.string().max(16384).nullable(),
  })
  .strict();
export const gitSystemCredentialSourceSchema = z
  .object({
    source: z.enum(["windows-credentials", "macos-keychain", "linux-secret-service"]),
    status: z.enum(["ok", "partial", "unavailable", "unsupported"]),
    accountCount: z.number().int().min(0).max(200),
  })
  .strict();
export const gitManagementDetectionSchema = z
  .object({
    binaryPath: z.string().nullable(),
    accounts: z.array(gitDetectedAccountSchema),
    sshDirectory: z.string(),
    privateKeyPaths: z.array(z.string()),
    sshKeys: z.array(gitDetectedSshKeySchema).max(200).default([]),
    systemCredentialSources: z.array(gitSystemCredentialSourceSchema).max(3).default([]),
    warnings: z.array(z.string()),
  })
  .strict();
export type GitConfiguration = z.infer<typeof gitConfigurationSchema>;
export type GitAccount = z.infer<typeof gitAccountSchema>;
export type GitAccountInput = z.infer<typeof gitAccountInputSchema>;
export type GitAuthenticationReference = z.infer<typeof gitAuthenticationReferenceSchema>;
export type GitManagementSnapshot = z.infer<typeof gitManagementSnapshotSchema>;
export type GitManagementMutation = z.infer<typeof gitManagementMutationSchema>;
export type GitDetectedAccount = z.infer<typeof gitDetectedAccountSchema>;
export type GitDetectedSshKey = z.infer<typeof gitDetectedSshKeySchema>;
export type GitSystemCredentialSource = z.infer<typeof gitSystemCredentialSourceSchema>;
export type GitManagementDetection = z.infer<typeof gitManagementDetectionSchema>;
export const gitAuthorizationCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("start"),
      requestId: z.string().uuid(),
      provider: z.enum(["github", "gitlab", "gitea"]),
      serverUrl: gitServerUrlSchema,
      clientId: text.min(1).max(200),
      redirectUri: z.string().max(512).default("http://127.0.0.1:17654/git-auth/callback"),
    })
    .strict(),
  z.object({ type: z.literal("poll"), requestId: z.string().uuid() }).strict(),
  z.object({ type: z.literal("cancel"), requestId: z.string().uuid() }).strict(),
  z
    .object({
      type: z.literal("callback"),
      requestId: z.string().uuid(),
      url: z.string().max(8192),
    })
    .strict(),
]);
export const gitAuthorizationStatusSchema = z
  .object({
    requestId: z.string().uuid(),
    status: z.enum(["pending", "ready", "saving", "saved", "cancelled", "failed", "expired"]),
    expiresAt: z.number(),
    pollAfterMs: z.number().min(0),
    authorizeUrl: z.string().optional(),
    userCode: z.string().optional(),
    username: z.string().optional(),
    accountId: z.string().uuid().optional(),
    error: z
      .enum([
        "oauth-unavailable",
        "oauth-invalid",
        "oauth-failed",
        "oauth-tls-untrusted",
        "oauth-tls-hostname",
        "oauth-tls-expired",
        "oauth-network",
        "oauth-client-invalid",
        "oauth-code-invalid",
        "oauth-permission",
        "oauth-token-exchange",
        "oauth-user-verification",
        "oauth-denied",
        "oauth-port-in-use",
        "oauth-expired",
      ])
      .optional(),
  })
  .strict();
export type GitAuthorizationCommand = z.infer<typeof gitAuthorizationCommandSchema>;
export type GitAuthorizationStatus = z.infer<typeof gitAuthorizationStatusSchema>;
