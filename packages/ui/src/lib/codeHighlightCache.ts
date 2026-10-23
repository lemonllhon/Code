type Subscriber<T> = (value: T) => void;
interface EngineEntry<E> {
  promise: Promise<E>;
  users: number;
}

/** Shiki 模块的单一缓存 owner；结果、在飞任务和引擎均在此收口。 */
export class CodeHighlightCache<T, E extends { dispose(): void }> {
  private results = new Map<string, { value: T; bytes: number }>();
  private engines = new Map<string, EngineEntry<E>>();
  private inflight = new Set<string>();
  private subscribers = new Map<string, Set<Subscriber<T>>>();
  private bytes = 0;
  private evictions = 0;
  constructor(
    private readonly options: {
      maxEntries: number;
      maxBytes: number;
      maxEngines: number;
      createEngine(language: string, theme: string): Promise<E>;
      tokenize(engine: E, code: string, language: string, theme: string): T;
      estimateBytes(key: string, result: T): number;
      onError?: (error: unknown) => void;
    },
  ) {}

  private key(code: string, language: string, theme: string) {
    // 首尾采样键会让等长代码的不同中段误命中；完整内容键随结果一起计入预算。
    return JSON.stringify([language, theme, code]);
  }
  stats() {
    return {
      entries: this.results.size,
      bytes: this.bytes,
      engines: this.engines.size,
      inflight: this.inflight.size,
      subscribers: [...this.subscribers.values()].reduce((n, s) => n + s.size, 0),
      evictions: this.evictions,
    };
  }
  unsubscribe(code: string, language: string, theme: string, callback: Subscriber<T>) {
    const key = this.key(code, language, theme);
    const set = this.subscribers.get(key);
    set?.delete(callback);
    if (set?.size === 0) this.subscribers.delete(key);
  }
  highlight(code: string, language: string, theme: string, callback?: Subscriber<T>): T | null {
    const key = this.key(code, language, theme);
    if (callback) {
      let set = this.subscribers.get(key);
      if (!set) {
        set = new Set();
        this.subscribers.set(key, set);
      }
      set.add(callback);
    }
    const cached = this.results.get(key);
    if (cached) {
      this.results.delete(key);
      this.results.set(key, cached);
      if (callback)
        queueMicrotask(() => {
          const set = this.subscribers.get(key);
          if (!set?.delete(callback)) return;
          if (set.size === 0) this.subscribers.delete(key);
          callback(cached.value);
        });
      return cached.value;
    }
    if (!this.inflight.has(key)) {
      this.inflight.add(key);
      void this.run(key, code, language, theme);
    }
    return null;
  }
  private async run(key: string, code: string, language: string, theme: string) {
    const engineKey = JSON.stringify([language, theme]);
    let entry = this.engines.get(engineKey);
    if (!entry) {
      entry = {
        promise: Promise.resolve().then(() => this.options.createEngine(language, theme)),
        users: 0,
      };
      this.engines.set(engineKey, entry);
    }
    this.engines.delete(engineKey);
    this.engines.set(engineKey, entry);
    entry.users++;
    try {
      const engine = await entry.promise.catch((error: unknown) => {
        if (this.engines.get(engineKey) === entry) this.engines.delete(engineKey);
        throw error;
      });
      const value = this.options.tokenize(engine, code, language, theme);
      const bytes = this.options.estimateBytes(key, value);
      if (bytes <= this.options.maxBytes) {
        this.results.set(key, { value, bytes });
        this.bytes += bytes;
        while (this.results.size > this.options.maxEntries || this.bytes > this.options.maxBytes) {
          const oldest = this.results.entries().next().value;
          if (!oldest) break;
          this.results.delete(oldest[0]);
          this.bytes -= oldest[1].bytes;
          this.evictions++;
        }
      }
      const callbacks = this.subscribers.get(key);
      this.subscribers.delete(key);
      for (const callback of callbacks ?? []) {
        try {
          callback(value);
        } catch (error) {
          this.options.onError?.(error);
        }
      }
    } catch (error) {
      // 失败 promise 必须移除，否则重开预览会永久命中已拒绝的初始化。
      this.subscribers.delete(key);
      this.options.onError?.(error);
    } finally {
      entry.users--;
      this.inflight.delete(key);
      for (const [candidate, idle] of this.engines) {
        if (this.engines.size <= this.options.maxEngines) break;
        if (idle.users !== 0) continue;
        this.engines.delete(candidate);
        try {
          (await idle.promise).dispose();
        } catch {
          /* 初始化失败已由 run 收口。 */
        }
      }
    }
  }
}
