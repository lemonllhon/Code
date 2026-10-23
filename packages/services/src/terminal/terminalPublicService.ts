import type { ITerminalService } from "./terminal.js";

/** 显式 RPC 白名单；TypeScript interface/cast 不会阻止 ProxyChannel 调用 owner 的内部方法。 */
export function createPublicTerminalService(owner: ITerminalService): ITerminalService {
  return {
    create: owner.create.bind(owner),
    write: owner.write.bind(owner),
    resize: owner.resize.bind(owner),
    dispose: owner.dispose.bind(owner),
    onDynamicData: owner.onDynamicData.bind(owner),
    onDynamicExit: owner.onDynamicExit.bind(owner),
    ...(owner.onDynamicOutput ? { onDynamicOutput: owner.onDynamicOutput.bind(owner) } : {}),
    ...(owner.beginOutputFlowControl
      ? { beginOutputFlowControl: owner.beginOutputFlowControl.bind(owner) }
      : {}),
    ...(owner.acknowledgeOutput ? { acknowledgeOutput: owner.acknowledgeOutput.bind(owner) } : {}),
  };
}
