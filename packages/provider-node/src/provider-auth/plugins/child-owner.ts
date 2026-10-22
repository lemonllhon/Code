import { terminateNodeProcessTree } from "../../process-tree.js";

/** 账本归父 transport；worker 崩溃后仍有能力回收本账号实际创建的活动子树。 */
export class PluginChildOwner {
  private readonly active = new Set<number>();
  private readonly ending = new Map<number, Promise<void>>();
  private closed = false;
  constructor(private readonly terminate = terminateNodeProcessTree) {}
  started(pid: number): void {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid)
      throw new Error("Invalid plugin child process");
    this.active.add(pid);
    if (this.closed) this.end(pid);
  }
  exited(pid: number): void {
    this.active.delete(pid);
  }
  private end(pid: number): void {
    if (this.ending.has(pid)) return;
    const result = this.terminate(pid);
    this.ending.set(pid, result);
    // 同一 Promise 留在账本，关闭时报告真实失败；避免 exit 回调产生 unhandled rejection。
    void result.catch(() => {});
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const pid of this.active) this.end(pid);
    const results = await Promise.allSettled(this.ending.values());
    const failures = results.filter((r) => r.status === "rejected").map((r) => r.reason);
    if (failures.length)
      throw new AggregateError(failures, "Provider child process cleanup failed");
  }
}
