import type { Logger } from "@lcode/contracts";
import { readRateLimitHint } from "@lcode/provider";
import type { RoutingUsage, RoutingFailureInfo } from "@lcode/shared";

/** 准入明确未派发时没有可归一化的租约；未知消费或已提交输出仍由原 owner 保守结算。 */
export function shouldReportRoutingFailure(
  routing: RoutingFailureInfo | undefined,
  outputCommitted = false,
): boolean {
  return outputCommitted || routing?.dispatch !== "unsent";
}

const FEEDBACK_TIMEOUT = 5000;
export function routingFailure(
  statusCode: number | undefined,
  headers: Record<string, string> | undefined,
  outputCommitted = false,
  cancelled = false,
): RoutingUsage {
  const values = new Headers(headers);
  const scope = values.get("x-lcode-rate-limit-scope")?.trim().toLowerCase();
  return {
    outcome: cancelled ? "cancelled" : "failed",
    replaySafeFailure:
      !cancelled && !outputCommitted && [400, 401, 403, 429].includes(statusCode ?? 0),
    ...(statusCode !== undefined && statusCode >= 400 && statusCode <= 599 ? { statusCode } : {}),
    ...(statusCode === 429 || (statusCode !== undefined && statusCode >= 500)
      ? { retryAfterMs: Math.min(86400000, readRateLimitHint(values).delayMs) }
      : {}),
    ...(scope === "key" ||
    scope === "shared" ||
    scope === "pool" ||
    scope === "model" ||
    scope === "provider"
      ? { rateLimitScope: scope }
      : {}),
  };
}

export function createRoutingFeedback(
  fetch: typeof globalThis.fetch,
  baseURL: string,
  apiKey: string | undefined,
  logger?: Logger,
) {
  let state = { pending: false, attempts: 0, delivered: false };
  const send = async (usage: RoutingUsage) => {
    const body = JSON.stringify(usage);
    state = { pending: true, attempts: 0, delivered: false };
    let statusCode: number | undefined;
    let failureKind: "http" | "timeout" | "network" | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      state.attempts++;
      try {
        const response = await fetch(`${baseURL}/routing/usage`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(FEEDBACK_TIMEOUT),
        });
        await response.body?.cancel();
        if (response.ok) {
          state.pending = false;
          state.delivered = true;
          return;
        }
        statusCode = response.status;
        failureKind = "http";
        if (response.status < 500 && response.status !== 429) break;
      } catch (error) {
        statusCode = undefined;
        failureKind =
          error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)
            ? "timeout"
            : "network";
        /* 网络未知只重试不可变反馈，不重放模型 POST。 */
      }
    }
    state.pending = false;
    logger?.warn(
      "Routing feedback unconfirmed after bounded retries; conservative reservation retained",
      {
        event: "model.routing.feedback_unconfirmed",
        module: "adapters.model",
        status: "failed",
        attempts: state.attempts,
        statusCode,
        failureKind,
        outcome: usage.outcome,
      },
    );
  };
  return Object.assign(send, { diagnostics: () => ({ ...state }) });
}
