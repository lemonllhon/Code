import type { IServiceAccessor } from "@lcode/services";
import {
  resolveWorkspaceServices,
  type WorkspaceServiceResolverState,
} from "../lib/workspaceServiceResolver.js";
import type { WorkspaceProjectMenuTab } from "../workspaceProjectMenu.js";
import type { DesktopWorkspaceReconnect } from "./windowWorkspaceReconnect.js";

/** 删除只信任当前 identity 绑定；重连前闭包里的 service/sessionId 不能跨 ready ACK 使用。 */
export async function resolveProjectDeletionServices(
  target: Pick<
    WorkspaceProjectMenuTab,
    "workspacePath" | "workspaceIdentity" | "remoteTarget" | "remoteSessionId"
  >,
  base: IServiceAccessor,
  readState: () => WorkspaceServiceResolverState,
  reconnect: DesktopWorkspaceReconnect | undefined,
  unavailableMessage: string,
): Promise<IServiceAccessor> {
  const remote = Boolean(target.workspaceIdentity || target.remoteTarget || target.remoteSessionId);
  if (remote && !target.workspaceIdentity?.trim()) throw new Error(unavailableMessage);
  // 中文依据：旧 sessionId 可能已被释放/换代；完整 identity 优先且不回退同路径本机或另一远端。
  const current = () =>
    resolveWorkspaceServices({ ...target, remoteSessionId: undefined }, base, readState());
  const ready = current();
  if (ready) return ready.services;
  if (!reconnect) throw new Error(unavailableMessage);
  await reconnect(target.workspaceIdentity!, {
    activateWorkspaceAfterReconnect: false,
    showErrorToast: false,
    throwOnFailure: true,
  });
  const reconnected = current();
  if (!reconnected) throw new Error(unavailableMessage);
  return reconnected.services;
}
