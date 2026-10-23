import type { HostApiNetworkTransport } from "@lcode/services/node";
import { runHostShutdownPhases } from "./hostShutdownPhases.js";

const DEFAULT_UNOWNED_TRANSPORT_DISPOSE_TIMEOUT_MS = 3_500;

export function resolveHostAgentWarmupTargets(message: {
  workspacePath?: string;
  workspaceIdentity?: string;
  agentWarmupTargets?: Array<{ workspacePath: string; workspaceIdentity?: string }>;
}): Array<{ workspacePath: string; workspaceIdentity?: string }> {
  // 空数组是 Main 明确的零预热决策；只有旧调用方缺失字段时才兼容本地路径。
  return (
    message.agentWarmupTargets ??
    (message.workspacePath
      ? [
          {
            workspacePath: message.workspacePath,
            ...(message.workspaceIdentity ? { workspaceIdentity: message.workspaceIdentity } : {}),
          },
        ]
      : [])
  );
}

export async function initializeHostApiNetworkTransportOwner<T>(params: {
  transport: Pick<HostApiNetworkTransport, "disposeAndWait">;
  establishOwner: () => T;
  disposeTimeoutMs?: number;
  log: (message: string, details: Record<string, unknown>) => void;
}): Promise<T> {
  try {
    return await params.establishOwner();
  } catch (initializationError) {
    // transport 在 ServiceCollection 接管前就会被启动预热请求使用；初始化中途抛错时，
    // 全局 activeServices 尚未赋值，进程级清理无法找到它。这里从创建点守住临时所有权，并用
    // deadline 避免 dispatcher 关闭卡住原始初始化错误的 fatal 收口。
    await runHostShutdownPhases(
      [
        {
          name: "unowned-host-api-network-transport-dispose",
          run: async () => {
            await params.transport.disposeAndWait();
          },
          timeoutMs: params.disposeTimeoutMs ?? DEFAULT_UNOWNED_TRANSPORT_DISPOSE_TIMEOUT_MS,
        },
      ],
      {
        phaseTimeoutMs: DEFAULT_UNOWNED_TRANSPORT_DISPOSE_TIMEOUT_MS,
        log: params.log,
      },
    );
    throw initializationError;
  }
}
