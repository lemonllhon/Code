import { useEffect, useState } from "react";
import type { LCodeTaskMeta } from "@lcode/shared";
import { useWorkspaceServicesResolution } from "./useWorkspaceServices.js";

/**
 * 为当前激活 task 提供一层只读 task-index meta 兜底。
 *
 * archived task 不在普通 taskListCache / pinnedTasks 数据源里，
 * 直接打开时 App 只靠列表元数据会拿不到标题、provider、traceId 等字段。
 * 这里在列表里找不到当前任务时，额外读取一次持久 meta 作为展示兜底，
 * 只服务当前激活任务，不把 archived task 混回普通列表。
 */
export function useActiveTaskSnapshotMeta(
  workspacePath: string,
  taskId: string | null,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string,
  taskMetaFromLists?: LCodeTaskMeta | null,
) {
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  const service = resolution.services.lcodeTaskService;
  const scope = JSON.stringify([
    workspaceIdentity?.trim() || workspacePath,
    workspacePath,
    resolution.remoteSessionId ?? null,
    taskId,
  ]);
  const [state, setState] = useState<{
    scope: string;
    service: typeof service;
    meta: LCodeTaskMeta | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;

    setState(null);
    if (!taskId || taskMetaFromLists || !resolution.rpcReady) {
      return () => {
        cancelled = true;
      };
    }

    // Bug 原因：readSession 只支持活跃 Runtime，标题读取会抢在冷会话恢复前失败。
    // 只读任务索引保留完整 meta，也能读取归档/冷 child；不引入第二条恢复生命周期。
    void service
      .getTaskMeta({
        workspacePath,
        workspaceIdentity,
        taskId,
      })
      .then((meta) => {
        if (cancelled) {
          return;
        }
        setState({ scope, service, meta });
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setState({ scope, service, meta: null });
      });

    return () => {
      cancelled = true;
    };
  }, [
    service,
    scope,
    taskId,
    taskMetaFromLists,
    workspaceIdentity,
    workspacePath,
    resolution.rpcReady,
  ]);

  // 同 taskId 也可能属于不同 workspace/Host；切换 render 时即隐藏旧值，不等 effect 清理。
  return resolution.rpcReady &&
    !taskMetaFromLists &&
    state?.scope === scope &&
    state.service === service
    ? state.meta
    : null;
}
