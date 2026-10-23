import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { LCodeUiError } from "./lcodeUiError.js";

const ROUTING_MESSAGE_IDS: Readonly<Record<string, string>> = {
  "concurrency-full": "chat.error.routing.busy",
  "quota-exhausted": "chat.error.routing.quota",
  "dispatch-uncertain": "chat.error.routing.dispatchUncertain",
};

export function formatRoutingErrorMessage(
  error: LCodeUiError,
  intl: IntlInstance,
): string | undefined {
  const attribution = error.attribution;
  if (attribution?.statusCode === 429) return undefined;
  const routing = attribution?.routing;
  const routingCode =
    routing?.code ?? /^Connection routing: ([a-z-]+)$/.exec(error.message.trim())?.[1];
  // 旧快照只有固定文案时给出一般提示，不能从缺少截止时间猜测 probing 或 uncertain。
  if (routingCode !== "route-cooling" && !ROUTING_MESSAGE_IDS[routingCode ?? ""]) return undefined;
  let id = ROUTING_MESSAGE_IDS[routingCode ?? ""] ?? "chat.error.routing.unavailable";
  const values: Record<string, string> = {};
  if (routing?.recoveryState === "probing") id = "chat.error.routing.probing";
  else if (routing?.recoveryState === "uncertain") id = "chat.error.routing.uncertain";
  else if (routing?.recoveryState === "cooling") {
    const date = new Date(routing.retryAt ?? NaN);
    if (Number.isFinite(date.valueOf())) {
      id = "chat.error.routing.coolingUntil";
      values.time = date.toLocaleString();
    } else id = "chat.error.routing.cooling";
  }
  const message = intl.formatMessage({ id }, values);
  return attribution?.retryBudgetExhausted || attribution?.retryDisposition === "exhausted"
    ? `${message} ${intl.formatMessage({ id: "chat.error.routing.retriesEnded" })}`
    : message;
}

export function routingErrorDetail(error: LCodeUiError): string | undefined {
  const attribution = error.attribution;
  if (!attribution?.routing) return error.detail;
  // 只把严格 schema 已验证的安全事实加入原详情，复制/反馈与详情窗口保持同源。
  const facts = Object.entries(attribution.routing)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `routing.${key}=${value}`);
  if (attribution.retryDisposition) facts.push(`retryDisposition=${attribution.retryDisposition}`);
  if (attribution.retryBudgetExhausted !== undefined)
    facts.push(`retryBudgetExhausted=${attribution.retryBudgetExhausted}`);
  return [error.detail, facts.join("\n")].filter(Boolean).join("\n\n");
}
