import type { LogContext, Logger } from "@lcode/contracts";

interface AiSdkWarningLoggerOptions {
  model?: unknown;
  provider?: unknown;
  warnings?: unknown;
}

type AiSdkWarningLogger = (options: AiSdkWarningLoggerOptions) => void;

type AiSdkWarningGlobal = typeof globalThis & {
  AI_SDK_LOG_WARNINGS?: false | AiSdkWarningLogger;
};

export function installLCodeProtocolAiSdkWarningLogger(logger: Logger): void {
  // AI SDK 默认 warning logger 第一次会用 console.info 写 stdout；
  // app-server --stdio 的 stdout 是 LCode Protocol NDJSON 帧通道，任何普通文本都会让宿主解析失败。
  (globalThis as AiSdkWarningGlobal).AI_SDK_LOG_WARNINGS = (options: AiSdkWarningLoggerOptions) => {
    try {
      const warnings = Array.isArray(options.warnings) ? options.warnings : [];
      logger.warn("AI SDK model warning", {
        event: "model.sdk.warning",
        module: "bootstrap.lcode_protocol",
        status: "completed",
        model: stringValue(options.model),
        provider: stringValue(options.provider),
        warningCount: warnings.length,
        warnings: warnings.slice(0, 20).map(summarizeWarning),
      });
    } catch {
      // warning 记录不能影响真实模型请求；stdout 纯净性由不调用 console.* 保证。
    }
  };
}

function summarizeWarning(warning: unknown): LogContext {
  if (!warning || typeof warning !== "object") {
    return { type: "unknown" };
  }
  const record = warning as Record<string, unknown>;
  return {
    // message/details 可能包含整段历史及工具参数；仅记录类型和大小，不能靠截断保护隐私。
    type: ["unsupported", "compatibility", "other"].includes(String(record.type))
      ? record.type
      : "unknown",
    messageChars: typeof record.message === "string" ? record.message.length : undefined,
    detailsPresent: record.details !== undefined,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, 128) : undefined;
}
