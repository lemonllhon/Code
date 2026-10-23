import { randomUUID } from "node:crypto";
import type { TerminalOutputFrame } from "./terminal.js";

const HIGH_WATER_MARK = 64 * 1024;
const LOW_WATER_MARK = 16 * 1024;

/** 一个真实 PTY 的输出压力 owner；不保存输出，不判断任务状态。 */
export class TerminalOutputFlow {
  private leaseId: string | undefined;
  private emitted = 0;
  private consumed = 0;
  private paused = false;

  constructor(
    private readonly pause: () => void,
    private readonly resume: () => void,
  ) {}

  start(): void {
    this.stop();
    this.leaseId = randomUUID();
  }

  frame(data: string): TerminalOutputFrame {
    if (!this.leaseId) return { data };
    this.emitted += data.length;
    if (!this.paused && this.emitted - this.consumed >= HIGH_WATER_MARK) {
      this.paused = true;
      this.pause();
    }
    return { data, flow: { leaseId: this.leaseId, offset: this.emitted } };
  }

  acknowledge(leaseId: string, offset: number): void {
    if (leaseId !== this.leaseId || offset > this.emitted) return;
    this.consumed = Math.max(this.consumed, offset);
    if (this.paused && this.emitted - this.consumed <= LOW_WATER_MARK) {
      // resume 可能同步排空原生缓冲；先发布状态，让重入的新输出还能再次 pause。
      this.paused = false;
      this.resume();
    }
  }

  stop(resume = true): void {
    this.leaseId = undefined;
    this.emitted = this.consumed = 0;
    if (this.paused && resume) this.resume();
    this.paused = false;
  }

  get diagnostics() {
    return { paused: this.paused ? 1 : 0, pendingChars: this.emitted - this.consumed };
  }
}
