interface ReclaimableWorkerPool {
  initialize(): Promise<void>;
  terminate(): void;
}

/** 窗口内共享池唯一 owner；通过 lease 管理，业务任务和 Root 状态不属于此生命周期。 */
export class DiffsWorkerPoolOwner<T extends ReclaimableWorkerPool> {
  private snapshot: {
    manager: T | undefined;
    ready: boolean;
    consumers: number;
    generation: number;
  } = {
    manager: undefined,
    ready: false,
    consumers: 0,
    generation: 0,
  };
  private listeners = new Set<() => void>();
  constructor(
    private readonly create: () => T,
    private readonly onError?: (error: unknown) => void,
  ) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<typeof this.snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  acquire = (): (() => void) => {
    this.publish({ consumers: this.snapshot.consumers + 1 });
    if (!this.snapshot.manager && !this.snapshot.ready) {
      const generation = this.snapshot.generation + 1;
      try {
        const manager = this.create();
        this.publish({ manager, generation });
        void this.initialize(manager, generation);
      } catch (error) {
        this.publish({ ready: true, generation });
        this.onError?.(error);
      }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.publish({ consumers: this.snapshot.consumers - 1 });
      // 同一 commit/StrictMode 的重新进入仍复用本代；不是用延时猜测任务是否结束。
      queueMicrotask(() => {
        if (this.snapshot.consumers !== 0) return;
        const { manager, generation } = this.snapshot;
        if (!manager && !this.snapshot.ready) return;
        this.publish({ manager: undefined, ready: false, generation: generation + 1 });
        manager?.terminate();
      });
    };
  };

  private async initialize(manager: T, generation: number) {
    try {
      await manager.initialize();
      if (this.snapshot.manager === manager && this.snapshot.generation === generation)
        this.publish({ ready: true });
    } catch (error) {
      // terminate 会拒绝旧代初始化；迟到失败不能清空新池或触发回退。
      if (this.snapshot.manager !== manager || this.snapshot.generation !== generation) return;
      manager.terminate();
      this.publish({ manager: undefined, ready: true });
      this.onError?.(error);
    }
  }
}
