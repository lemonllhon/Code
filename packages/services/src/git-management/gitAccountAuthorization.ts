import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  gitAuthorizationCommandSchema,
  type GitAuthorizationCommand,
  type GitAuthorizationStatus,
} from "@lcode/shared";
import {
  gitOAuthEndpoints,
  postOAuth,
  verifyOAuthGrant,
  type GitOAuthGrant,
  type GitOAuthFetch,
} from "./gitOAuthTransport.js";
import { gitOAuthFailure } from "./gitOAuthErrors.js";

type Start = Extract<GitAuthorizationCommand, { type: "start" }>;
type Attempt = {
  input: Start;
  status: GitAuthorizationStatus;
  controller: AbortController;
  state: string;
  verifier: string;
  grant?: GitOAuthGrant;
  device?: string;
  interval: number;
  nextPoll: number;
  busy: boolean;
  server?: Server;
  timer?: ReturnType<typeof setTimeout>;
  starting?: Promise<void>;
};
export function createGitAccountAuthorization(
  options: { http?: GitOAuthFetch; now?: () => number } = {},
) {
  const http = options.http ?? fetch,
    now = options.now ?? Date.now,
    attempts = new Map<string, Attempt>();
  const stop = (a: Attempt, keepExpiry = false) => {
    if (a.server?.listening) a.server.close();
    a.server = undefined;
    if (!keepExpiry) clearTimeout(a.timer);
  };
  const fail = (a: Attempt, error: GitAuthorizationStatus["error"]) => {
    a.status.status = error === "oauth-expired" ? "expired" : "failed";
    a.status.error = error;
    a.grant = undefined;
    a.verifier = "";
    a.device = undefined;
    stop(a);
  };
  const expire = (a: Attempt) => {
    if (
      !["saved", "saving", "cancelled", "failed", "expired"].includes(a.status.status) &&
      now() >= a.status.expiresAt
    ) {
      a.controller.abort();
      fail(a, "oauth-expired");
    }
  };
  const snapshot = (a: Attempt): GitAuthorizationStatus => {
    // 中文依据：结束后的授权页/设备码已失效，只在 pending 投影，避免 UI 引导重用旧 state。
    const { authorizeUrl, userCode, ...status } = a.status;
    return {
      ...status,
      ...(status.status === "pending" ? { authorizeUrl, userCode } : {}),
      pollAfterMs: Math.max(0, a.nextPoll - now()),
    };
  };
  const get = (id: string) => {
    const a = attempts.get(id);
    if (!a) throw new Error("oauth-invalid");
    expire(a);
    return a;
  };
  const callback = async (a: Attempt, raw: string) => {
    expire(a);
    if (a.status.status !== "pending" || a.busy || a.input.provider === "github")
      throw new Error("oauth-invalid");
    const uri = new URL(raw),
      expected = new URL(a.input.redirectUri),
      state = uri.searchParams.get("state") ?? "";
    const receivedState = Buffer.from(state),
      expectedState = Buffer.from(a.state);
    if (
      uri.origin !== expected.origin ||
      uri.pathname !== expected.pathname ||
      uri.username ||
      uri.password ||
      uri.hash ||
      uri.searchParams.getAll("state").length !== 1 ||
      uri.searchParams.getAll("code").length > 1 ||
      receivedState.length !== expectedState.length ||
      !timingSafeEqual(receivedState, expectedState)
    )
      throw new Error("oauth-invalid");
    if (uri.searchParams.has("error")) {
      fail(a, "oauth-denied");
      return;
    }
    const code = uri.searchParams.get("code");
    if (!code || code.length > 4096) throw new Error("oauth-invalid");
    a.busy = true;
    try {
      const token = await postOAuth(
        http,
        gitOAuthEndpoints(a.input.provider, a.input.serverUrl).token,
        {
          grant_type: "authorization_code",
          client_id: a.input.clientId,
          redirect_uri: a.input.redirectUri,
          code,
          code_verifier: a.verifier,
        },
        a.controller.signal,
      );
      const grant = await verifyOAuthGrant(http, a.input, token, a.controller.signal);
      // 关闭监听不能销毁仍在返回成功页的回调连接；ready grant 仍保留到期清理计时器。
      if (a.status.status === "pending" && !a.controller.signal.aborted) {
        a.grant = grant;
        a.status.status = "ready";
        a.status.username = grant.username;
        a.verifier = "";
        a.device = undefined;
        stop(a, true);
      }
    } catch (error) {
      if (a.status.status === "pending") fail(a, gitOAuthFailure(error, "oauth-token-exchange"));
    } finally {
      a.busy = false;
    }
  };
  const start = async (a: Attempt) => {
    try {
      const endpoints = gitOAuthEndpoints(a.input.provider, a.input.serverUrl);
      if (a.input.provider === "github") {
        const response = await postOAuth(
          http,
          endpoints.device,
          { client_id: a.input.clientId, scope: endpoints.scope },
          a.controller.signal,
        );
        const verify = new URL(String(response.verification_uri ?? ""));
        if (
          verify.origin !== new URL(a.input.serverUrl).origin ||
          verify.username ||
          verify.password ||
          verify.hash ||
          typeof response.device_code !== "string" ||
          typeof response.user_code !== "string" ||
          !Number.isFinite(Number(response.expires_in)) ||
          Number(response.expires_in) <= 0
        )
          throw new Error("oauth-invalid");
        if (a.controller.signal.aborted) return;
        a.device = response.device_code;
        a.interval = Math.max(1000, Number(response.interval || 5) * 1000);
        if (!Number.isFinite(a.interval) || a.interval > 60000) throw new Error("oauth-invalid");
        a.status.authorizeUrl = verify.href;
        a.status.userCode = response.user_code.slice(0, 100);
        a.status.expiresAt = Math.min(
          a.status.expiresAt,
          now() + Number(response.expires_in) * 1000,
        );
        a.nextPoll = now() + a.interval;
      } else {
        const redirect = new URL(a.input.redirectUri);
        if (
          redirect.protocol !== "http:" ||
          redirect.hostname !== "127.0.0.1" ||
          !redirect.port ||
          redirect.username ||
          redirect.password ||
          redirect.search ||
          redirect.hash ||
          redirect.pathname !== "/git-auth/callback"
        )
          throw new Error("oauth-invalid");
        const server = createServer((req, res) => {
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Content-Security-Policy", "default-src 'none'");
          if (req.method !== "GET" || req.headers.host !== redirect.host) {
            res.writeHead(400).end("Invalid authorization callback.");
            return;
          }
          void callback(a, new URL(req.url ?? "/", redirect.origin).href).then(
            () => {
              res
                .writeHead(a.status.status === "ready" ? 200 : 400)
                .end(
                  a.status.status === "ready"
                    ? "Authorization completed. Return to LCode and save the account."
                    : "Authorization was not completed. Return to LCode for the error details.",
                );
            },
            () => res.writeHead(400).end("Invalid or expired authorization callback."),
          );
        });
        a.server = server;
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(Number(redirect.port), "127.0.0.1", () => {
            server.removeListener("error", reject);
            resolve();
          });
        });
        server.unref();
        server.maxConnections = 4;
        server.headersTimeout = 10000;
        server.requestTimeout = 15000;
        server.on("error", () => {
          if (a.status.status === "pending") fail(a, "oauth-failed");
        });
        if (a.controller.signal.aborted) {
          stop(a);
          return;
        }
        const url = new URL(endpoints.authorize);
        url.search = new URLSearchParams({
          client_id: a.input.clientId,
          redirect_uri: a.input.redirectUri,
          response_type: "code",
          scope: endpoints.scope,
          state: a.state,
          code_challenge: createHash("sha256").update(a.verifier).digest("base64url"),
          code_challenge_method: "S256",
        }).toString();
        a.status.authorizeUrl = url.href;
      }
      a.timer = setTimeout(
        () => {
          if (a.status.status !== "saving") {
            a.controller.abort();
            fail(a, "oauth-expired");
          }
        },
        Math.max(1, a.status.expiresAt - now()),
      );
      a.timer.unref();
    } catch (error) {
      if (a.status.status === "pending")
        fail(
          a,
          (error as NodeJS.ErrnoException).code === "EADDRINUSE"
            ? "oauth-port-in-use"
            : gitOAuthFailure(error),
        );
    }
  };
  return {
    async command(input: GitAuthorizationCommand): Promise<GitAuthorizationStatus> {
      const request = gitAuthorizationCommandSchema.parse(input);
      if (request.type === "start") {
        let a = attempts.get(request.requestId);
        if (a) {
          if (JSON.stringify(a.input) !== JSON.stringify(request)) throw new Error("oauth-invalid");
          await a.starting;
          return snapshot(get(request.requestId));
        }
        if (attempts.size >= 30) {
          for (const [id, old] of attempts) {
            expire(old);
            if (["failed", "expired", "cancelled", "saved"].includes(old.status.status))
              attempts.delete(id);
          }
          if (attempts.size >= 30) throw new Error("oauth-unavailable");
        }
        a = {
          input: request,
          status: {
            requestId: request.requestId,
            status: "pending",
            expiresAt: now() + 600000,
            pollAfterMs: 0,
          },
          controller: new AbortController(),
          state: randomBytes(32).toString("base64url"),
          verifier: randomBytes(48).toString("base64url"),
          interval: 5000,
          nextPoll: 0,
          busy: false,
        };
        attempts.set(request.requestId, a);
        a.starting = start(a);
        await a.starting;
        return snapshot(a);
      }
      const a = get(request.requestId);
      if (request.type === "cancel") {
        if (!["saving", "saved"].includes(a.status.status)) {
          a.controller.abort();
          stop(a);
          a.status.status = "cancelled";
          a.grant = undefined;
          a.verifier = "";
          a.device = undefined;
        }
      } else if (request.type === "callback") await callback(a, request.url);
      else if (
        a.input.provider === "github" &&
        a.device &&
        a.status.status === "pending" &&
        !a.busy &&
        now() >= a.nextPoll
      ) {
        a.busy = true;
        a.nextPoll = now() + a.interval;
        try {
          const token = await postOAuth(
            http,
            gitOAuthEndpoints(a.input.provider, a.input.serverUrl).token,
            {
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              client_id: a.input.clientId,
              device_code: a.device,
            },
            a.controller.signal,
          );
          if (token.error === "slow_down") {
            a.interval += 5000;
            a.nextPoll = now() + a.interval;
          } else if (token.error === "access_denied") fail(a, "oauth-denied");
          else if (token.error === "expired_token") fail(a, "oauth-expired");
          else if (token.error && token.error !== "authorization_pending") fail(a, "oauth-failed");
          else if (!token.error) {
            const grant = await verifyOAuthGrant(http, a.input, token, a.controller.signal);
            if (a.status.status === "pending" && !a.controller.signal.aborted) {
              a.grant = grant;
              a.status.username = grant.username;
              a.status.status = "ready";
              a.device = undefined;
            }
          }
        } catch (error) {
          if (a.status.status === "pending")
            fail(a, gitOAuthFailure(error, "oauth-token-exchange"));
        } finally {
          a.busy = false;
        }
      }
      return snapshot(a);
    },
    beginSave(id: string) {
      const a = get(id);
      if (a.status.status !== "ready" || !a.grant) throw new Error("oauth-invalid");
      a.status.status = "saving";
      return structuredClone(a.grant);
    },
    rollbackSave(id: string) {
      const a = get(id);
      if (a.status.status === "saving") a.status.status = "ready";
    },
    finishSave(id: string, accountId: string) {
      const a = get(id);
      a.status.status = "saved";
      a.status.accountId = accountId;
      a.grant = undefined;
      a.device = undefined;
      a.verifier = "";
      stop(a);
    },
    dispose() {
      for (const a of attempts.values()) {
        a.controller.abort();
        stop(a);
        a.grant = undefined;
      }
      attempts.clear();
    },
  };
}
