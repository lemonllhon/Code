import { CoreErrorType, createCoreError } from "@lcode/contracts";

interface Waiter {
  limit: number;
  signal?: AbortSignal;
  abort: () => void;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
}
const cancelled = () =>
  createCoreError(CoreErrorType.ToolCancelled, "Tool execution cancelled", { recoverable: true });

/** 同一 executor 的所有入口共用；许可跟随真实 handler 收尾，不随超时外壳提前释放。 */
export class ToolExecutionPermits {
  private readonly active = new Map<symbol, number>();
  private readonly waiting: Waiter[] = [];

  constructor(private readonly maximum: number) {
    if (!Number.isInteger(maximum) || maximum < 1)
      throw new Error("Tool concurrency must be a positive integer");
  }

  acquire(signal?: AbortSignal, requested = this.maximum): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(cancelled());
    if (!Number.isInteger(requested) || requested < 1)
      return Promise.reject(new Error("Invalid tool concurrency limit"));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        limit: Math.min(requested, this.maximum),
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.waiting.indexOf(waiter);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          signal?.removeEventListener("abort", waiter.abort);
          reject(cancelled());
          this.drain();
        },
      };
      this.waiting.push(waiter);
      signal?.addEventListener("abort", waiter.abort, { once: true });
      if (signal?.aborted) waiter.abort();
      else this.drain();
    });
  }

  private drain(): void {
    while (this.waiting.length) {
      const waiter = this.waiting[0]!;
      const limit = Math.min(this.maximum, waiter.limit, ...this.active.values());
      if (this.active.size >= limit) return;
      this.waiting.shift();
      waiter.signal?.removeEventListener("abort", waiter.abort);
      const token = Symbol();
      this.active.set(token, waiter.limit);
      waiter.resolve(() => {
        // finally、取消与错误收尾可重复抵达，释放必须幂等。
        if (!this.active.delete(token)) return;
        this.drain();
      });
    }
  }
}
