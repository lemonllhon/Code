const PROVIDER_BUSINESS_ERROR_CODES = [
  "1006",
  "1005",
  "3006",
  "3001",
  "3007",
  "3008",
  "3009",
  "3010",
  "3002",
  "3102",
  "2007",
  "429",
] as const;

type ProviderBusinessErrorCode = (typeof PROVIDER_BUSINESS_ERROR_CODES)[number];

export type ProviderBusinessErrorUiAction =
  | "login"
  | "refresh-quota"
  | "switch-model"
  | "retry-later"
  | "upgrade";

const PROVIDER_BUSINESS_ERROR_MESSAGE_IDS: Record<ProviderBusinessErrorCode, string> = {
  "1006": "lcode.error.providerBusiness.1006",
  "1005": "lcode.error.providerBusiness.1005",
  "3006": "lcode.error.providerBusiness.3006",
  "3002": "lcode.error.providerBusiness.3002",
  "3001": "lcode.error.providerBusiness.3001",
  "3007": "lcode.error.providerBusiness.3007",
  "3008": "lcode.error.providerBusiness.3008",
  "3009": "lcode.error.providerBusiness.3009",
  "3010": "lcode.error.providerBusiness.3010",
  "3102": "lcode.error.providerBusiness.3102",
  "2007": "lcode.error.providerBusiness.2007",
  "429": "lcode.error.providerBusiness.429",
};

const PROVIDER_BUSINESS_ERROR_UI_ACTIONS: Record<
  ProviderBusinessErrorCode,
  ProviderBusinessErrorUiAction | null
> = {
  "1006": "login",
  "1005": "refresh-quota",
  "3006": "switch-model",
  "3001": null,
  // 3007 安全校验拒绝：客户端无法完成安全校验，没有可执行的恢复动作。
  "3007": null,
  // 3008/3009/3010 表示供应商并发上限。
  "3008": "upgrade",
  "3009": "upgrade",
  "3010": "upgrade",
  "3002": "retry-later",
  "3102": null,
  "2007": "retry-later",
  "429": "retry-later",
};

export function isProviderBusinessErrorCode(
  code: string | undefined,
): code is ProviderBusinessErrorCode {
  if (!code) {
    return false;
  }
  return (PROVIDER_BUSINESS_ERROR_CODES as readonly string[]).includes(code);
}

export function getProviderBusinessErrorMessageId(code: string | undefined): string | undefined {
  if (!isProviderBusinessErrorCode(code)) {
    return undefined;
  }
  return PROVIDER_BUSINESS_ERROR_MESSAGE_IDS[code];
}

export function getProviderBusinessErrorUiAction(
  code: string | undefined,
): ProviderBusinessErrorUiAction | null {
  if (!isProviderBusinessErrorCode(code)) {
    return null;
  }
  return PROVIDER_BUSINESS_ERROR_UI_ACTIONS[code];
}

/** 与 core `model-errors.ts` 中 anomaly guard 文案保持一致。 */
export const SUSPICIOUS_EMPTY_MODEL_RESULT_MESSAGE =
  "Model returned no text, no tool calls, and no usage before completing the turn.";

export function isSuspiciousEmptyModelResultMessage(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  return (
    message.includes(SUSPICIOUS_EMPTY_MODEL_RESULT_MESSAGE) ||
    message.includes("Model returned no text")
  );
}
