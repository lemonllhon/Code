import { z } from "zod";
import type { GitAccountInput } from "@lcode/shared";
import { gitOAuthFailure } from "./gitOAuthErrors.js";

const secret = z
  .string()
  .min(1)
  .max(16384)
  .refine((v) => ![...v].some((char) => [0, 10, 13].includes(char.charCodeAt(0))));
export const gitOAuthGrantSchema = z
  .object({
    provider: z.enum(["github", "gitlab", "gitea"]),
    serverUrl: z.string(),
    username: z.string().min(1).max(512),
    subject: z.string().min(1).max(256),
    clientId: z.string(),
    accessToken: secret,
    refreshToken: secret.optional(),
    expiresAt: z.number().optional(),
  })
  .strict();
export type GitOAuthGrant = z.infer<typeof gitOAuthGrantSchema>;
export type GitOAuthFetch = typeof fetch;
export function gitOAuthEndpoints(provider: GitAccountInput["provider"], serverUrl: string) {
  const base = new URL(serverUrl);
  if (
    !["https:", "http:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))
  )
    throw new Error("oauth-invalid");
  const root = base.origin + base.pathname.replace(/\/+$/, "");
  const endpoint = (path: string) => root + path;
  return {
    serverUrl: root,
    authorize: endpoint(provider === "gitea" ? "/login/oauth/authorize" : "/oauth/authorize"),
    token: endpoint(
      provider === "github"
        ? "/login/oauth/access_token"
        : provider === "gitea"
          ? "/login/oauth/access_token"
          : "/oauth/token",
    ),
    device: endpoint("/login/device/code"),
    user:
      provider === "github"
        ? base.hostname === "github.com"
          ? "https://api.github.com/user"
          : endpoint("/api/v3/user")
        : endpoint(provider === "gitlab" ? "/api/v4/user" : "/api/v1/user"),
    scope:
      provider === "github"
        ? "repo read:user"
        : provider === "gitlab"
          ? "read_user read_repository write_repository"
          : "read:user write:repository",
  };
}
export async function readOAuthJson(http: GitOAuthFetch, url: string, options: RequestInit = {}) {
  let response: Response;
  try {
    response = await http(url, {
      ...options,
      redirect: "error",
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
      headers: { Accept: "application/json", ...options.headers },
    });
  } catch (error) {
    throw new Error(gitOAuthFailure(error, "oauth-network"));
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("oauth-failed");
  let size = 0;
  const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 128 * 1024) throw new Error("oauth-failed");
      parts.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const result: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("oauth-failed");
  if (!response.ok) {
    const code = (result as { error?: unknown }).error;
    throw new Error(
      code === "invalid_client"
        ? "oauth-client-invalid"
        : code === "invalid_grant"
          ? "oauth-code-invalid"
          : code === "invalid_scope" || [401, 403].includes(response.status)
            ? "oauth-permission"
            : "oauth-failed",
    );
  }
  return result as Record<string, unknown>;
}
export const postOAuth = (
  http: GitOAuthFetch,
  url: string,
  body: Record<string, string>,
  signal?: AbortSignal,
) =>
  readOAuthJson(http, url, {
    method: "POST",
    body: new URLSearchParams(body),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal,
  });
export async function verifyOAuthGrant(
  http: GitOAuthFetch,
  context: { provider: GitOAuthGrant["provider"]; serverUrl: string; clientId: string },
  token: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<GitOAuthGrant> {
  const parsedToken = secret.safeParse(token.access_token);
  if (!parsedToken.success) throw new Error("oauth-token-exchange");
  const accessToken = parsedToken.data;
  const endpoints = gitOAuthEndpoints(context.provider, context.serverUrl);
  let user: Record<string, unknown>;
  try {
    user = await readOAuthJson(http, endpoints.user, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal,
    });
  } catch (error) {
    throw new Error(gitOAuthFailure(error, "oauth-user-verification"));
  }
  const username = context.provider === "gitlab" ? user.username : user.login;
  const expires =
    typeof token.expires_in === "number"
      ? token.expires_in
      : typeof token.expires_in === "string"
        ? Number(token.expires_in)
        : undefined;
  const grant = gitOAuthGrantSchema.safeParse({
    provider: context.provider,
    serverUrl: endpoints.serverUrl,
    clientId: context.clientId,
    username,
    subject: typeof user.id === "number" || typeof user.id === "string" ? String(user.id) : "",
    accessToken,
    ...(typeof token.refresh_token === "string" ? { refreshToken: token.refresh_token } : {}),
    ...(expires && Number.isFinite(expires) && expires > 0
      ? { expiresAt: Date.now() + expires * 1000 }
      : {}),
  });
  if (!grant.success) throw new Error("oauth-user-verification");
  return grant.data;
}
export async function refreshGitOAuthGrant(http: GitOAuthFetch, grant: GitOAuthGrant) {
  if (!grant.refreshToken) throw new Error("oauth-expired");
  const token = await postOAuth(http, gitOAuthEndpoints(grant.provider, grant.serverUrl).token, {
    grant_type: "refresh_token",
    refresh_token: grant.refreshToken,
    client_id: grant.clientId,
  });
  const next = await verifyOAuthGrant(http, grant, token);
  if (next.subject !== grant.subject || next.username !== grant.username)
    throw new Error("oauth-failed");
  return { ...next, refreshToken: next.refreshToken ?? grant.refreshToken };
}
