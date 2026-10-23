import { ModelErrorCode, ModelRetryReason } from "@lcode/contracts";
import {
  routingFailureCodeSchema,
  routingFailureInfoSchema,
  type RoutingFailureInfo,
} from "@lcode/shared";
import { getApiCallResponseBody, parseRetryAfterMs } from "./failure-inspection.js";
import type { ClassifiedModelFailure } from "./failure-types.js";

function metadata(error: unknown): RoutingFailureInfo | undefined {
  const seen = new Set<object>();
  let current = error;
  for (
    let depth = 0;
    depth < 8 && current && typeof current === "object" && !seen.has(current);
    depth++
  ) {
    seen.add(current);
    const record = current as {
      details?: unknown;
      data?: { error?: { routing?: unknown } };
      cause?: unknown;
    };
    const body = getApiCallResponseBody(current) as { error?: { routing?: unknown } } | undefined;
    for (const input of [record.details, record.data?.error?.routing, body?.error?.routing]) {
      const parsed = routingFailureInfoSchema.safeParse(input);
      if (parsed.success) return parsed.data;
    }
    current = record.cause;
  }
  return undefined;
}

/** 固定路由原因先于网络/TLS；UNCERTAIN 的字母片段不能成为证书错误。只传递严格安全元数据。 */
export function classifyRoutingFailure(
  error: unknown,
  code?: string,
  headers?: Record<string, string>,
  statusCode?: number,
): ClassifiedModelFailure | undefined {
  const details = metadata(error);
  const parsed = routingFailureCodeSchema.safeParse(
    headers?.["x-zcode-routing-reason"] ?? code ?? details?.code,
  );
  if (!parsed.success) return undefined;
  const reason = parsed.data;
  const routing = {
    ...(details?.code === reason ? details : {}),
    code: reason,
    ...(reason === "dispatch-uncertain" ? { dispatch: "uncertain" as const } : {}),
  };
  const retryReason =
    statusCode === 429
      ? ModelRetryReason.RateLimited
      : reason === "route-cooling"
        ? ModelRetryReason.RouteCooling
        : ModelRetryReason.RoutingUnavailable;
  return {
    code: ModelErrorCode.ModelRequestFailed,
    message: `Connection routing: ${reason}`,
    // 本地健康恢复拒绝没有上游 429；保留独立原因，避免错误提示及遥测冒充供应商限流。
    reason: retryReason,
    retryReason,
    retryable: ["route-cooling", "concurrency-full", "policy-conflict"].includes(reason),
    retryAfterMs:
      parseRetryAfterMs(headers) ??
      (routing.retryAt !== undefined ? Math.max(0, routing.retryAt - Date.now()) : undefined),
    statusCode,
    routing,
  };
}
