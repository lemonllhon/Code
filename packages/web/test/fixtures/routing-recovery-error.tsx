import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatErrorBanner } from "@/ChatErrorBanner.js";
import { ChatApiRetryStatus } from "@/chat-input-toolbar/display.js";
import { Button } from "@/components/ui/button.js";
import { LCodeIntlProvider, useLCodeIntl } from "@/i18n/IntlProvider.js";
import { normalizeLCodeUiError } from "@/lib/lcodeUiError.js";
import { applyTheme } from "@/useTheme.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
localStorage.setItem("lcode-locale-preference", params.get("locale") ?? "zh-CN");
applyTheme(params.get("theme") === "light" ? "zai-light" : "zai-dark");

function RetryLabel() {
  const { intl, locale } = useLCodeIntl();
  return (
    <div data-testid="model-retry-progress">
      <ChatApiRetryStatus
        intl={intl}
        locale={locale}
        apiRetry={{
          kind: "api_retry",
          attempt: 5,
          maxRetries: 10,
          retryDelayMs: 1000,
          errorStatus: null,
          error: "fault.runtime.routingUnavailable",
        }}
      />
    </div>
  );
}

function Fixture() {
  const [state, setState] = useState("cooling");
  const [copied, setCopied] = useState("");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        setCopied(text);
      },
    },
  });
  const codes: Record<string, string> = {
    busy: "concurrency-full",
    quota: "quota-exhausted",
    dispatch: "dispatch-uncertain",
  };
  const routingCode = codes[state] ?? "route-cooling";
  const payload = {
    code: state === "missing-model" ? "MODEL_CONFIG_MISSING" : "MODEL_REQUEST_FAILED",
    message: state === "429" ? "Upstream HTTP 429" : `Connection routing: ${routingCode}`,
    detail: "synthetic turn diagnostic",
    attribution:
      state === "legacy"
        ? undefined
        : {
            source: state === "429" ? "provider" : "runtime",
            reason:
              state === "429"
                ? "rate_limited"
                : codes[state]
                  ? "routing_unavailable"
                  : "route_cooling",
            ...(state === "429"
              ? { statusCode: 429 }
              : {
                  routing: {
                    code: routingCode,
                    phase: "admission",
                    scope: "model",
                    dispatch: state === "dispatch" ? "uncertain" : "unsent",
                    ...(!codes[state]
                      ? {
                          recoveryState:
                            state === "exhausted" || state === "missing-model" ? "cooling" : state,
                        }
                      : {}),
                    ...(state === "cooling" || state === "exhausted"
                      ? { retryAt: 2000000000000 }
                      : {}),
                  },
                  retryDisposition: state === "exhausted" ? "exhausted" : "retryable",
                  retryBudgetExhausted: state === "exhausted",
                }),
          },
  };
  // 模拟 continuous 事件和 replayable snapshot 共用的严格归因输入，不在 UI 推断 owner 状态。
  const error = normalizeLCodeUiError(
    JSON.parse(JSON.stringify({ data: { lcode: { error: payload } } })),
  );
  return (
    <LCodeIntlProvider>
      <main className="p-4 space-y-4 text-ui-base">
        <RetryLabel />
        <div className="flex flex-wrap gap-2">
          {[
            "cooling",
            "probing",
            "uncertain",
            "exhausted",
            "legacy",
            "busy",
            "quota",
            "dispatch",
            "429",
            "missing-model",
          ].map((value) => (
            <Button key={value} data-testid={`state-${value}`} onClick={() => setState(value)}>
              {value}
            </Button>
          ))}
        </div>
        <ChatErrorBanner error={error} onRetry={() => {}} />
        <output data-testid="copied-error" hidden>
          {copied}
        </output>
      </main>
    </LCodeIntlProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
