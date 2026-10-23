import { RoutingError, waitForRateLimitDelay, type RoutingRequest } from "@lcode/provider";
import type { ApiKeyLease } from "./api-key-lease.js";
import { waitForApiKeyCapacity } from "./api-key-capacity.js";

export function apiKeyAdmissionRequest(
  context: RoutingRequest | undefined,
  round: number,
): RoutingRequest | undefined {
  return context && round
    ? { ...context, attemptId: `${context.attemptId}:admission:${round}` }
    : context;
}
export type OutsideApiKeyTicket = (
  wait: () => Promise<void>,
  signal?: AbortSignal,
) => Promise<void>;
interface AcquisitionHost {
  signal: AbortSignal;
  waitMs(): number;
  indexReady(): boolean;
  prepareIndex(signal: AbortSignal): Promise<void>;
  prepareInline(signal: AbortSignal): boolean;
  capacitySignal(): AbortSignal;
  reserve(round: number): ApiKeyLease;
  prepareShared?(lease: ApiKeyLease, signal: AbortSignal): Promise<ApiKeyLease>;
  waitSharedCapacity?(lease: ApiKeyLease, signal: AbortSignal): Promise<boolean>;
}
/** 仅编排原池的 admission，等待不占 Key/Token 预留，也不增加 Runner 尝试。 */
export async function acquireApiKeyLease(
  host: AcquisitionHost,
  outside: OutsideApiKeyTicket,
): Promise<ApiKeyLease> {
  const signal = host.signal;
  let round = 0;
  for (;;) {
    signal.throwIfAborted();
    if (host.waitMs() > 0)
      await outside(async () => {
        for (;;) {
          signal.throwIfAborted();
          const delay = host.waitMs();
          if (delay === 0) return;
          await waitForRateLimitDelay(delay, signal);
        }
      }, signal);
    // 小目录在一个有界片段内即可完成，不为纯同步计算额外释放/重获物理 admission。
    if (!host.indexReady() && !host.prepareInline(signal)) {
      try {
        await outside(() => host.prepareIndex(signal), signal);
      } catch (error) {
        if (error instanceof RoutingError && error.code === "policy-conflict" && !signal.aborted)
          continue;
        throw error;
      }
    }
    signal.throwIfAborted();
    // admission 重获期间 profile 可被 LRU 淘汰或并发 429 失效；预留前必须重读。
    if (host.waitMs() > 0 || !host.indexReady()) continue;
    // 先取得变化游标再 reserve；同步拒绝后即使槽位已归还，也不会丢失唤醒。
    const changed = host.capacitySignal();
    let lease: ApiKeyLease;
    try {
      lease = host.reserve(round);
    } catch (error) {
      if (!(error instanceof RoutingError) || error.code !== "concurrency-full") throw error;
      await outside(() => waitForApiKeyCapacity(changed, signal), signal);
      continue;
    }
    if (!host.prepareShared || !lease.sharedQuotaInput) return lease;
    try {
      let prepared!: ApiKeyLease;
      await outside(async () => {
        prepared = await host.prepareShared!(lease, signal);
      }, signal);
      return prepared;
    } catch (error) {
      lease.release();
      if (
        error instanceof RoutingError &&
        error.code === "concurrency-full" &&
        host.waitSharedCapacity
      ) {
        let available = false;
        await outside(async () => {
          available = await host.waitSharedCapacity!(lease, signal);
        }, signal);
        if (available) {
          // 共享 owner 已明确拒绝，原预留没有派发。取消句柄不能再用；只换准入身份，
          // invocation 的 scope/createdAt/deadline 保持原值，不增加模型尝试或重放 POST。
          round++;
          continue;
        }
      }
      throw error;
    }
  }
}
