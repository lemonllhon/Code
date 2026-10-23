import type { ErrorAttribution } from "@lcode/contracts";
import { routingFailureInfoSchema } from "@lcode/shared/provider-routing";

/** 原 adapter 已知的安全事实随错误投影传递，不能让 UI 从英文文案反推恢复状态。 */
export function projectRoutingAttribution(
  contexts: readonly Record<string, unknown>[],
): Pick<ErrorAttribution, "routing" | "retryDisposition" | "retryBudgetExhausted"> {
  const result: Pick<ErrorAttribution, "routing" | "retryDisposition" | "retryBudgetExhausted"> =
    {};
  for (const context of contexts) {
    const routing = routingFailureInfoSchema.safeParse(context.routing);
    if (!result.routing && routing.success) result.routing = routing.data;
    const disposition = context.retryDisposition;
    if (
      !result.retryDisposition &&
      (disposition === "retryable" || disposition === "exhausted" || disposition === "terminal")
    )
      result.retryDisposition = disposition;
    if (
      result.retryBudgetExhausted === undefined &&
      typeof context.retryBudgetExhausted === "boolean"
    )
      result.retryBudgetExhausted = context.retryBudgetExhausted;
  }
  return result;
}
