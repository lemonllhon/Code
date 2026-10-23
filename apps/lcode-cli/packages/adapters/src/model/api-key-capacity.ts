/** 原 Pool 的容量变化提示；无业务队列，不复制 Scheduler 的在途数量。 */
export class ApiKeyCapacity {
  private change = new AbortController();
  get signal(): AbortSignal {
    return this.change.signal;
  }
  notify(): void {
    const previous = this.change;
    this.change = new AbortController();
    previous.abort();
  }
}

export function waitForApiKeyCapacity(change: AbortSignal, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (change.aborted) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      change.removeEventListener("abort", ready);
      signal.removeEventListener("abort", cancel);
    };
    const ready = () => {
      cleanup();
      resolve();
    };
    const cancel = () => {
      cleanup();
      reject(signal.reason);
    };
    change.addEventListener("abort", ready, { once: true });
    signal.addEventListener("abort", cancel, { once: true });
  });
}
