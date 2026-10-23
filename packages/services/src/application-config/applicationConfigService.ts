import type { ApiClient, ForceUpdateConfig } from "@lcode/shared";
import {
  buildRuntimeLCodeApiUrl,
  createDynamicWorkflowClientConfig,
  DEFAULT_DYNAMIC_WORKFLOW_MODE,
  LCODE_DYNAMIC_WORKFLOW_MODE_ENV,
  LCODE_VERSION,
  normalizeDynamicWorkflowMode,
  resolveDynamicWorkflowClientConfig,
} from "@lcode/shared";
import type { IApplicationConfigService } from "./applicationConfig.js";
import { readApiJson } from "../providers/api/apiJson.js";
import { createServiceLogger } from "../logger/serviceLogger.js";

interface ClientConfigEnvelope {
  code?: number;
  msg?: string;
  data?: {
    configs?: {
      forceUpdate?: ForceUpdateConfig | null;
      dynamicWorkflow?: { mode?: unknown } | null;
    } | null;
  } | null;
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const log = createServiceLogger("application-config");

/** 应用配置只拥有配置快照，不依赖账号、支付或套餐状态。 */
export function createApplicationConfigService(options: {
  apiClient: ApiClient;
}): IApplicationConfigService {
  let snapshot: ClientConfigEnvelope | null = null;
  let expiresAt = 0;
  let pending: Promise<ClientConfigEnvelope> | null = null;
  const getConfigs = async (): Promise<ClientConfigEnvelope> => {
    if (snapshot && expiresAt > Date.now()) return snapshot;
    if (pending) return pending;
    const url = new URL(buildRuntimeLCodeApiUrl(process.env, "/api/v1/client/configs"));
    url.searchParams.set("app_version", LCODE_VERSION);
    url.searchParams.set("platform", `${process.platform}-${process.arch}`);
    // 合并的是完成校验的配置请求，避免并发调用直接拿到未校验的 HTTP 信封。
    const request = (async () => {
      const payload = await readApiJson<ClientConfigEnvelope>(options.apiClient, url, {
        method: "GET",
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      if (payload.code !== undefined && payload.code !== 0) {
        throw new Error(payload.msg?.trim() || "LCode client config request failed");
      }
      snapshot = payload;
      expiresAt = Date.now() + CACHE_TTL_MS;
      return snapshot;
    })();
    pending = request;
    try {
      return await request;
    } finally {
      if (pending === request) pending = null;
    }
  };
  return {
    async getDynamicWorkflowClientConfig(input) {
      if (normalizeDynamicWorkflowMode(process.env[LCODE_DYNAMIC_WORKFLOW_MODE_ENV])) {
        return resolveDynamicWorkflowClientConfig({ remote: undefined, env: process.env });
      }
      if (input?.forceRefresh) {
        snapshot = null;
        expiresAt = 0;
      }
      try {
        const payload = await getConfigs();
        return resolveDynamicWorkflowClientConfig({
          remote: payload.data?.configs?.dynamicWorkflow,
          env: process.env,
        });
      } catch (error) {
        log.warn(undefined, "动态工作流配置读取失败，使用内置默认值", {
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        return createDynamicWorkflowClientConfig(DEFAULT_DYNAMIC_WORKFLOW_MODE, "default");
      }
    },
    async getForceUpdateConfig() {
      const config = (await getConfigs()).data?.configs?.forceUpdate;
      const minimalVersion = config?.minimalVersion;
      return typeof minimalVersion === "string" && minimalVersion.trim()
        ? { minimalVersion: minimalVersion.trim() }
        : null;
    },
  };
}
