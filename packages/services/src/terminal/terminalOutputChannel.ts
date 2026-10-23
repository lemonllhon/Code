import { Emitter, type Event } from "@lcode/rpc";
import type { IPty } from "node-pty";
import type { TerminalOutputFrame } from "./terminal.js";
import { TerminalOutputFlow } from "./terminalOutputFlow.js";

/** TerminalService 内部的单个 PTY 输出资源，不保存任务状态或输出队列。 */
export class TerminalOutputChannel {
  private readonly emitter = new Emitter<TerminalOutputFrame>();
  private flow: TerminalOutputFlow | undefined;
  private consumers = 0;
  private closed = false;

  bind(pty: IPty): void {
    if (typeof pty.pause === "function" && typeof pty.resume === "function") {
      this.flow = new TerminalOutputFlow(
        () => pty.pause(),
        () => pty.resume(),
      );
    }
  }

  readonly event: Event<TerminalOutputFrame> = (listener) => {
    if (this.closed) return { dispose() {} };
    const subscription = this.emitter.event(listener);
    this.consumers++;
    // 多观察者没有唯一消费水位，不能让最快观察者替慢观察者确认。
    if (this.consumers > 1) this.flow?.stop();
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        subscription.dispose();
        this.consumers--;
        // 最后一个消费者离开即恢复生产者，隐藏的持久终端仍保留原订阅。
        if (this.consumers === 0) this.flow?.stop(!this.closed);
      },
    };
  };

  fire(data: string): void {
    if (!this.closed) this.emitter.fire(this.flow?.frame(data) ?? { data });
  }

  begin(): void {
    if (!this.closed && this.consumers === 1) this.flow?.start();
  }

  acknowledge(leaseId: string, offset: number): void {
    this.flow?.acknowledge(leaseId, offset);
  }

  close(): void {
    this.closed = true;
    this.flow?.stop(false);
    this.flow = undefined;
    this.emitter.dispose();
  }

  get supported(): boolean {
    return Boolean(this.flow);
  }
  get diagnostics() {
    return this.flow?.diagnostics ?? { paused: 0, pendingChars: 0 };
  }
}
