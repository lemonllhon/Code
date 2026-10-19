import { z } from "zod";
import {
  describeProviderProvisioningFailure,
  ProviderProvisioningStageError,
  type ProviderProvisioningFailure,
} from "@lcode/shared";
import { decodeLCodeBuiltinRelease, type LCodeBuiltinRelease } from "./lcode-builtin-release.js";

const clientConfigSchema = z
  .object({
    code: z.literal(0),
    data: z
      .object({
        configs: z
          .object({
            builtin_provider_config_json: z
              .string()
              .url()
              .refine((value) => {
                const url = new URL(value);
                return url.protocol === "https:" && !url.username && !url.password;
              })
              .optional(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

export interface LCodeBuiltinDownloadOptions {
  readonly endpointOrigin: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly request: (url: string | URL, init: RequestInit) => Promise<Response>;
  readonly signal?: AbortSignal;
}

/** App/CLI 共用下载边界。总预算包含两次请求正文，不依赖 ApiClient 的响应头超时。 */
export async function downloadLCodeBuiltinRelease(
  options: LCodeBuiltinDownloadOptions,
): Promise<LCodeBuiltinRelease | null> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 20_000);
  timer.unref?.();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  let stage: "client-config" | "cdn" = "client-config";
  try {
    const url = new URL("/api/v1/client/configs", options.endpointOrigin);
    url.searchParams.set("app_version", options.appVersion);
    url.searchParams.set("platform", options.platform);
    const payload = clientConfigSchema.parse(await readJson(url));
    const downloadUrl = payload.data.configs.builtin_provider_config_json;
    if (downloadUrl === undefined) return null;
    stage = "cdn";
    return decodeLCodeBuiltinRelease(await readJson(new URL(downloadUrl)));
  } catch (error) {
    // 修复：用固定字段保留下载阶段和 HTTP 状态，避免脱敏后所有失败都变成 unknown；
    // URL、正文、Schema 输入和原始 cause 不得离开下载边界。
    const reason = signal.aborted
      ? timedOut
        ? "timeout"
        : "cancelled"
      : error instanceof DownloadBoundaryError
        ? error.reason
        : error instanceof z.ZodError
          ? "invalid-schema"
          : error instanceof SyntaxError
            ? "invalid-response"
            : "network-error";
    const code: ProviderProvisioningFailure["code"] =
      reason === "cancelled"
        ? "cancelled"
        : ["invalid-schema", "invalid-response", "empty-body", "body-limit"].includes(reason)
          ? "invalid-config"
          : "network-error";
    const systemCode = describeProviderProvisioningFailure("provider-runtime", error).systemCode;
    throw new ProviderProvisioningStageError({
      stage: "provider-runtime",
      code,
      ...(systemCode ? { systemCode } : {}),
      download: {
        stage,
        reason,
        ...(error instanceof DownloadBoundaryError && error.httpStatus !== undefined
          ? { httpStatus: error.httpStatus }
          : {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }

  async function readJson(url: URL): Promise<unknown> {
    signal.throwIfAborted();
    // 每次新建请求选项，不继承控制面鉴权；不跟随重定向把下载变成任意新来源。
    const response = await abortable(
      options
        .request(url, { method: "GET", signal, credentials: "omit", redirect: "error" })
        .then((value) => {
          if (signal.aborted) {
            void value.body?.cancel().catch(() => {});
            signal.throwIfAborted();
          }
          return value;
        }),
      signal,
    );
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new DownloadBoundaryError("http-error", response.status);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new DownloadBoundaryError("empty-body");
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await abortable(reader.read(), signal);
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 10_000_000) throw new DownloadBoundaryError("body-limit");
        chunks.push(decoder.decode(part.value, { stream: true }));
      }
      chunks.push(decoder.decode());
      signal.throwIfAborted();
      return JSON.parse(chunks.join("")) as unknown;
    } catch (error) {
      // cancel 不得成为新的无期限等待；释放 reader 后底层请求仍由同一 signal 取消。
      void reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
}

class DownloadBoundaryError extends Error {
  constructor(
    readonly reason: "http-error" | "empty-body" | "body-limit",
    readonly httpStatus?: number,
  ) {
    super(reason);
  }
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
