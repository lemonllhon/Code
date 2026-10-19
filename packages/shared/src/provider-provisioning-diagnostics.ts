import { z } from "zod";

export const providerConfigCandidateStateSchema = z.enum([
  "available",
  "missing",
  "invalid",
  "permission-denied",
  "io-error",
]);
export const providerBuiltinAvailabilitySchema = z
  .object({
    bundled: providerConfigCandidateStateSchema,
    active: providerConfigCandidateStateSchema,
  })
  .strict();
export type ProviderBuiltinAvailability = z.infer<typeof providerBuiltinAvailabilitySchema>;

export const providerBuiltinDownloadFailureSchema = z
  .object({
    stage: z.enum(["client-config", "cdn"]),
    reason: z.enum([
      "http-error",
      "timeout",
      "cancelled",
      "invalid-response",
      "invalid-schema",
      "empty-body",
      "body-limit",
      "network-error",
    ]),
    httpStatus: z.number().int().min(100).max(599).optional(),
  })
  .strict();

export const providerProvisioningStageSchema = z.enum([
  "registration",
  "local-personal",
  "local-settings",
  "local-credentials",
  "local-envelope",
  "remote-request",
  "remote-envelope",
  "remote-state",
  "remote-runtime",
  "remote-before-state",
  "remote-settings",
  "remote-credentials",
  "remote-personal",
  "remote-account",
  "remote-registry",
  "remote-default",
  "remote-state-write",
  "remote-rollback",
  "provider-runtime",
]);
export type ProviderProvisioningStage = z.infer<typeof providerProvisioningStageSchema>;
export const providerProvisioningFailureSchema = z
  .object({
    stage: providerProvisioningStageSchema,
    code: z.enum([
      "credential-decrypt",
      "credential-key-missing",
      "credential-key-invalid",
      "weak-secret",
      "builtin-unavailable",
      "permission-denied",
      "file-missing",
      "invalid-config",
      "storage-full",
      "io-error",
      "network-error",
      "path-unavailable",
      "conflict",
      "default-unavailable",
      "unsupported",
      "stale-registration",
      "cancelled",
      "diagnostics-unavailable",
      "unknown",
    ]),
    systemCode: z
      .enum([
        "EACCES",
        "EPERM",
        "EROFS",
        "ENOENT",
        "ENOTDIR",
        "EEXIST",
        "EIO",
        "ENOSPC",
        "ETIMEDOUT",
        "ECONNRESET",
        "ECONNREFUSED",
        "ENOTFOUND",
        "EPIPE",
      ])
      .optional(),
    availability: providerBuiltinAvailabilitySchema.optional(),
    download: providerBuiltinDownloadFailureSchema.optional(),
  })
  .strict();
export type ProviderProvisioningFailure = z.infer<typeof providerProvisioningFailureSchema>;

const codes: Record<string, ProviderProvisioningFailure["code"]> = {
  LCODE_CREDENTIAL_DECRYPT_FAILED: "credential-decrypt",
  LCODE_CREDENTIAL_KEY_MISSING: "credential-key-missing",
  LCODE_CREDENTIAL_KEY_INVALID: "credential-key-invalid",
  LCODE_CREDENTIAL_SECRET_WEAK: "weak-secret",
  LCODE_CREDENTIAL_STORE_INVALID: "invalid-config",
  LCODE_BUILTIN_CONFIG_UNAVAILABLE: "builtin-unavailable",
  LCODE_PROVISIONING_CONFLICT: "conflict",
  LCODE_PROVISIONING_DEFAULT_UNAVAILABLE: "default-unavailable",
  LCODE_PROVISIONING_INVALID: "invalid-config",
  EACCES: "permission-denied",
  EPERM: "permission-denied",
  EROFS: "permission-denied",
  ENOENT: "file-missing",
  ENOTDIR: "path-unavailable",
  EEXIST: "path-unavailable",
  ENOSPC: "storage-full",
  EIO: "io-error",
  ETIMEDOUT: "network-error",
  ECONNRESET: "network-error",
  ECONNREFUSED: "network-error",
  ENOTFOUND: "network-error",
  EPIPE: "network-error",
};

/** 只读取受限结构字段；自由文本、stack 和任何原始配置均不能成为诊断。 */
export function describeProviderProvisioningFailure(
  stage: ProviderProvisioningStage,
  error: unknown,
): ProviderProvisioningFailure {
  const pending: unknown[] = [error];
  for (let depth = 0; depth < 8 && pending.length; depth++) {
    const current = pending.shift();
    if (typeof current !== "object" || current === null) continue;
    const value = current as Record<string, unknown>;
    const existing = providerProvisioningFailureSchema.safeParse(value.failure);
    if (existing.success) return existing.data;
    const code =
      typeof value.code === "string" && Object.hasOwn(codes, value.code)
        ? codes[value.code]
        : undefined;
    if (code) {
      const system = providerProvisioningFailureSchema.shape.systemCode.safeParse(value.code);
      const availability = providerBuiltinAvailabilitySchema.safeParse(value.availability);
      return {
        stage,
        code,
        ...(system.success ? { systemCode: system.data } : {}),
        ...(availability.success ? { availability: availability.data } : {}),
      };
    }
    if (value.name === "ZodError" || value.name === "SyntaxError")
      return { stage, code: "invalid-config" };
    if (value.name === "AbortError") return { stage, code: "cancelled" };
    if (value.cause) pending.push(value.cause);
    if (Array.isArray(value.errors)) pending.push(...value.errors.slice(0, 4));
  }
  return { stage, code: "unknown" };
}

export class ProviderProvisioningStageError extends Error {
  readonly failure: ProviderProvisioningFailure;
  constructor(failure: ProviderProvisioningFailure, cause?: unknown) {
    super(formatProviderProvisioningFailure(failure), { cause });
    this.failure = providerProvisioningFailureSchema.parse(failure);
  }
}

export async function runProviderProvisioningStage<T>(
  stage: ProviderProvisioningStage,
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new ProviderProvisioningStageError(
      describeProviderProvisioningFailure(stage, error),
      error,
    );
  }
}

const stageLabels: Record<ProviderProvisioningStage, string> = {
  registration: "远端连接注册",
  "local-personal": "读取本地 Provider 配置",
  "local-settings": "读取本地账号设置",
  "local-credentials": "读取本地凭据",
  "local-envelope": "校验本地同步数据",
  "remote-request": "远端同步请求",
  "remote-envelope": "校验远端同步数据",
  "remote-state": "读取远端同步状态",
  "remote-runtime": "初始化远端 Provider",
  "remote-before-state": "读取远端回滚前像",
  "remote-settings": "写入远端账号设置",
  "remote-credentials": "写入远端凭据",
  "remote-personal": "写入远端 Provider 配置",
  "remote-account": "刷新远端账号",
  "remote-registry": "刷新远端模型目录",
  "remote-default": "校验远端默认模型",
  "remote-state-write": "持久化远端同步结果",
  "remote-rollback": "回滚远端同步",
  "provider-runtime": "Provider 配置运行时",
};
const codeLabels: Record<ProviderProvisioningFailure["code"], string> = {
  "credential-decrypt": "凭据解密失败",
  "credential-key-missing": "LCode 密钥文件丢失",
  "credential-key-invalid": "LCode 密钥文件无效",
  "weak-secret": "显式密钥强度不足",
  "builtin-unavailable": "内置 Provider 配置不可用",
  "permission-denied": "文件权限不足或目录只读",
  "file-missing": "所需文件缺失",
  "invalid-config": "配置格式或字段无效",
  "storage-full": "存储空间不足",
  "io-error": "文件读写失败",
  "network-error": "网络请求失败或连接断开",
  "path-unavailable": "配置路径或文件锁不可用",
  conflict: "同步期间配置被其它操作修改",
  "default-unavailable": "远端不支持本地默认模型",
  unsupported: "远端不支持 Provider 同步",
  "stale-registration": "远端连接注册已失效",
  cancelled: "操作已取消",
  "diagnostics-unavailable": "远端未提供结构化原因，请更新远端组件",
  unknown: "未分类错误（原始错误文本已隐藏）",
};
const candidateLabels: Record<z.infer<typeof providerConfigCandidateStateSchema>, string> = {
  available: "可用",
  missing: "缺失",
  invalid: "格式无效",
  "permission-denied": "权限不足",
  "io-error": "读写失败",
};

export function formatProviderProvisioningFailure(failure: ProviderProvisioningFailure): string {
  const state = failure.availability;
  const detail = state
    ? `；随包配置${candidateLabels[state.bundled]}，活动配置${candidateLabels[state.active]}`
    : "";
  const download = failure.download;
  const downloadLabels = {
    "http-error": "HTTP 请求失败",
    timeout: "下载超时",
    cancelled: "下载已取消",
    "invalid-response": "正文不是有效 JSON",
    "invalid-schema": "配置字段无效",
    "empty-body": "响应正文为空",
    "body-limit": "响应正文超过限制",
    "network-error": "网络请求失败",
  };
  const downloadDetail = download
    ? `；${download.stage === "client-config" ? "控制面配置" : "CDN 配置"}：${downloadLabels[download.reason]}${download.httpStatus === undefined ? "" : ` (HTTP ${download.httpStatus})`}`
    : "";
  return `${stageLabels[failure.stage]}：${codeLabels[failure.code]}${failure.systemCode ? ` (${failure.systemCode})` : ""}${detail}${downloadDetail}`;
}
