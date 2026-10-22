/** 跨 adapter/Core 的恢复资格；不依赖具体 Error 类或自由文本。 */
export function readModelFailureDisposition(
  error: unknown,
): "terminal" | "exhausted" | "retryable" | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as { retryable?: unknown; context?: Record<string, unknown> };
  const context = record.context;
  // 同时携带 retryable=false 的已耗尽错误仍保留预算事实，重复归一化不能重新获得预算。
  if (context?.retryBudgetExhausted === true || context?.retryDisposition === "exhausted")
    return "exhausted";
  if (
    record.retryable === false ||
    context?.retryable === false ||
    context?.retryDisposition === "terminal"
  )
    return "terminal";
  if (record.retryable === true || context?.retryable === true) return "retryable";
  return undefined;
}
