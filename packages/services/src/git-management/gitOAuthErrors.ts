import type { GitAuthorizationStatus } from "@lcode/shared";

type Failure = NonNullable<GitAuthorizationStatus["error"]>;
const publicErrors = new Set<Failure>([
  "oauth-unavailable",
  "oauth-invalid",
  "oauth-failed",
  "oauth-denied",
  "oauth-port-in-use",
  "oauth-expired",
  "oauth-tls-untrusted",
  "oauth-tls-hostname",
  "oauth-tls-expired",
  "oauth-network",
  "oauth-client-invalid",
  "oauth-code-invalid",
  "oauth-permission",
  "oauth-token-exchange",
  "oauth-user-verification",
]);

/** 只投影固定类别，禁止传播包含地址、授权码或令牌的底层 message/body。 */
export function gitOAuthFailure(error: unknown, fallback: Failure = "oauth-failed"): Failure {
  let cause = error;
  for (let depth = 0; cause && typeof cause === "object" && depth < 6; depth++) {
    if (
      cause instanceof Error &&
      cause.message !== "oauth-failed" &&
      publicErrors.has(cause.message as Failure)
    )
      return cause.message as Failure;
    const item = cause as { code?: string; cause?: unknown };
    if (item.code === "ERR_TLS_CERT_ALTNAME_INVALID") return "oauth-tls-hostname";
    if (["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID"].includes(item.code ?? ""))
      return "oauth-tls-expired";
    if (
      [
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
        "SELF_SIGNED_CERT_IN_CHAIN",
        "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        "CERT_UNTRUSTED",
      ].includes(item.code ?? "")
    )
      return "oauth-tls-untrusted";
    cause = item.cause;
  }
  return fallback;
}
