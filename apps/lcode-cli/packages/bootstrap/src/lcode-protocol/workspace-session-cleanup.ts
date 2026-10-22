import type { SessionId } from "@lcode/contracts";
import { lcodeSessionWorkspaceCleanupParamsSchema } from "@lcode/shared";
import { parseParams, type LCodeProtocolAgentServerContext } from "./server-types.js";

/** 受信 Host 的项目维护入口：不 hydrate、不调用模型，不把关闭会话误当作永久删除。 */
export async function cleanupWorkspaceSessions(
  context: LCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(lcodeSessionWorkspaceCleanupParamsSchema, rawParams);
  const store = context.deps.sessionStore;
  if (!store?.workspaceCleanup)
    throw new Error("Agent does not support permanent project chat deletion; update the Agent");
  const run = async () => {
    context.assertServing?.();
    const matching = await store.workspaceCleanup!({ ...params, sessionIds: undefined });
    if (!params.sessionIds) return matching;
    const allowed = new Set(matching.sessionIds);
    const workspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
    const residentIds = [...context.sessions]
      .filter(([, record]) => record.workspace?.workspaceKey === workspaceKey)
      .map(([id]) => id);
    const closingIds = [...new Set([...params.sessionIds, ...residentIds])];
    for (const id of params.sessionIds) {
      if (!allowed.has(id))
        throw new Error("Session is outside the confirmed workspace cleanup scope");
    }
    for (const id of closingIds) {
      const record = context.sessions.get(id);
      if (
        record &&
        (record.activeAbortController ||
          record.residencyFinalizationCount ||
          record.app.runtime.hasResidencyBlockingWork() ||
          context.v4Interactions.hasPendingForSession(id) ||
          context.v4Gateway?.hasResidencyBlockingCommands(id))
      )
        throw new Error("Project session is running; stop it before deleting the project");
    }
    if (allowed.size !== new Set(params.sessionIds).size)
      throw new Error("Workspace cleanup set changed; query again before deleting");
    for (const id of closingIds) {
      const record = context.sessions.get(id);
      if (!record) continue;
      record.unsubscribe?.();
      await record.app.close?.();
      context.v4Gateway?.disposeSession(id);
      context.sessions.delete(id);
      await record.eventStore.deleteSession(id as SessionId);
    }
    const deleted = await store.workspaceCleanup!(params);
    if (deleted.sessionIds.length && !context.deps.deleteSessionDiagnostics)
      throw new Error("Project diagnostics deletion capability is unavailable");
    await context.deps.deleteSessionDiagnostics?.(deleted.sessionIds);
    return deleted;
  };
  // 与受信资源释放共享排他维护边界；新建/发送不能越过冻结集合与正文清理。
  const maintenanceIds = [
    ...new Set([
      ...(params.sessionIds ?? []),
      ...[...context.sessions]
        .filter(
          ([, record]) =>
            record.workspace?.workspaceKey ===
            (params.workspaceIdentity?.trim() || params.workspacePath),
        )
        .map(([id]) => id),
    ]),
  ];
  return params.sessionIds && context.sessionResidentPool
    ? context.sessionResidentPool.withMaintenance(maintenanceIds, run, {
        exclusiveProtocol: true,
        currentProtocolOperation: true,
      })
    : run();
}
