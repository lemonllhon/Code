import type { ProviderApiKey } from "@lcode/provider";
import { ApiKeyPool, type ApiKeyFailoverState, type ApiKeyLease } from "./api-key-pool.js";
import { observeApiKeyResponse } from "./api-key-response.js";
import { normalizeContentRefusalResponse } from "@lcode/provider-node";

export type { ApiKeyFailoverState } from "./api-key-pool.js";

export function withApiKeyLease(
  fetch: typeof globalThis.fetch,
  lease: ApiKeyLease,
  providerKind: string,
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    // 私有副本可直接写 headers；额外临时 clone 的取消 controller 在 GC 后会断开上游信号。
    request.headers.set("Authorization", `Bearer ${lease.key.apiKey}`);
    if (providerKind === "anthropic") request.headers.set("x-api-key", lease.key.apiKey);
    if (lease.sharedQuotaInput && !lease.admit) throw new Error("routing-capability-required");
    if (lease.admit && !(await lease.admit())) throw new Error("attempt-already-dispatched");
    try {
      request.signal.throwIfAborted();
      if (lease.begin && !lease.begin()) throw new Error("attempt-already-dispatched");
    } catch (error) {
      // 已持久化许可但尚未调用 fetch，只有此处能证明全局消费为零。
      await lease.rollbackDispatch?.();
      throw error;
    }
    let response: Response;
    try {
      // SDK 解析之前就会更新 key 健康；必须先区分内容拒绝，避免误禁用并轮换同一请求。
      response = await normalizeContentRefusalResponse(await fetch(request));
    } catch (error) {
      lease.end?.(false);
      throw error;
    }
    if (!request.signal.aborted) lease.observe(response.status, response.headers);
    // 响应头与 abort 同拍时 cancel 可能因 source 已 errored 而拒绝。必须先交给同一
    // body owner 观察真实 read 终态，再抛取消；独立 cancel-only 分支会漏掉槽位收尾。
    const observed =
      lease.end || request.signal.aborted
        ? observeApiKeyResponse(response, request.signal, lease.end ?? (() => {}))
        : response;
    request.signal.throwIfAborted();
    return observed;
  };
}

/** 公开 helper 保留有限轮换语义；正常 Runner 使用单租约 fetch，不在此隐藏多次 POST。 */
export function createApiKeyFailoverFetch(options: {
  readonly fetch: typeof globalThis.fetch;
  readonly keys: readonly ProviderApiKey[];
  readonly providerKind: string;
  readonly state?: ApiKeyFailoverState;
  readonly pool?: ApiKeyPool;
}): typeof globalThis.fetch {
  if (!options.keys.length) return options.fetch;
  const state = options.state;
  const pool =
    options.pool ??
    (state?.pool?.sourceKeys === options.keys ? state.pool : new ApiKeyPool(options.keys, state));
  if (state) state.pool = pool;
  return async (input, init) => {
    const template = new Request(input, init);
    for (;;) {
      template.signal.throwIfAborted();
      const lease = await pool.acquire(template.signal);
      try {
        const response = await withApiKeyLease(
          options.fetch,
          lease,
          options.providerKind,
        )(template.clone());
        if (pool.routingEnabled || !lease.canRotate) return response;
        await response.body?.cancel();
      } finally {
        lease.release();
      }
    }
  };
}
