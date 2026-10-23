import type { ITerminalService, TerminalOutputFrame } from "@lcode/services";
import type { IDisposable } from "@lcode/rpc";
import type { Terminal } from "@xterm/xterm";
import { logger } from "@/logger.js";
import { normalizePowerShellReadlineRedraw } from "./terminalDataTransform.js";

/** 数据订阅和消费 ACK 共用原 term/PTY 生命周期；隐藏不注销，真正释放才 dispose。 */
export function subscribeTerminalOutput(
  service: ITerminalService,
  id: string,
  term: Pick<Terminal, "write">,
  shell: string,
  flowControl = false,
): IDisposable {
  if (
    !flowControl ||
    !service.onDynamicOutput ||
    !service.beginOutputFlowControl ||
    !service.acknowledgeOutput
  ) {
    return service.onDynamicData(id)((data) =>
      term.write(normalizePowerShellReadlineRedraw(data, shell)),
    );
  }
  let disposed = false;
  let queued = false;
  let consumed: TerminalOutputFrame["flow"];
  const acknowledge = (flow: NonNullable<TerminalOutputFrame["flow"]>) => {
    if (disposed) return;
    if (!consumed || consumed.leaseId !== flow.leaseId || consumed.offset < flow.offset)
      consumed = flow;
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const ack = consumed;
      consumed = undefined;
      if (disposed || !ack) return;
      void service.acknowledgeOutput!({ id, ...ack }).catch((error) =>
        logger.debug("[Terminal] output ACK interrupted", error),
      );
    });
  };
  const subscription = service.onDynamicOutput(id)((frame) => {
    if (disposed) return;
    const { flow } = frame;
    // 保留原 chunk 的 PowerShell 重绘归一化；仅实际 write callback 可以归还消费额度。
    term.write(
      normalizePowerShellReadlineRedraw(frame.data, shell),
      flow ? () => acknowledge(flow) : undefined,
    );
  });
  // 先订阅再开启背压；新输出携带服务端消费代际，ACK 不依赖 start 的返回时机。
  void service
    .beginOutputFlowControl({ id })
    .catch((error) => logger.debug("[Terminal] output flow unavailable", error));
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      consumed = undefined;
      subscription.dispose();
    },
  };
}
