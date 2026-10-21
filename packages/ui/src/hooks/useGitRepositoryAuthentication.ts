import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { gitRepositoryAuthenticationSchema, type GitRepositoryAuthentication } from "@lcode/shared";
import { useWorkspaceServicesResolution } from "./useWorkspaceServices.js";
const empty = {
  snapshot: null as GitRepositoryAuthentication | null,
  pending: false,
  error: null as string | null,
};
export function useGitRepositoryAuthentication(options: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  revision?: string;
}) {
  const resolution = useWorkspaceServicesResolution(
    options.workspacePath,
    options.workspaceRemoteSessionId,
    options.workspaceIdentity,
  );
  const service = resolution.services.gitManagementService;
  const context = useMemo(
    () => ({
      service,
      ready: resolution.rpcReady,
      remoteSessionId: resolution.remoteSessionId,
      request: {
        workspacePath: options.workspacePath,
        workspaceIdentity: options.workspaceIdentity,
      },
    }),
    [
      service,
      resolution.rpcReady,
      resolution.remoteSessionId,
      options.workspacePath,
      options.workspaceIdentity,
    ],
  );
  const latest = useRef(context);
  latest.current = context;
  const active = useRef<object | null>(null);
  const [value, setValue] = useState({ context, data: empty });
  const state = value.context === context ? value.data : empty;
  const patch = useCallback(
    (data: Partial<typeof empty>) => {
      if (latest.current === context)
        setValue((old) => ({
          context,
          data: { ...(old.context === context ? old.data : empty), ...data },
        }));
    },
    [context],
  );
  const refresh = useCallback(async () => {
    const token = {};
    active.current = token;
    // 同 scope 重读只禁用选择；清空列表会让远端表单和滚动位置在每次刷新时跳动。
    patch({ pending: true, error: null });
    try {
      if (!context.ready || !service?.getRepositoryAuthentication) throw new Error("unavailable");
      const snapshot = gitRepositoryAuthenticationSchema.parse(
        await service.getRepositoryAuthentication(context.request),
      );
      if (active.current === token) patch({ snapshot });
    } catch {
      if (active.current === token) patch({ error: "loadFailed" });
    } finally {
      if (active.current === token) {
        active.current = null;
        patch({ pending: false });
      }
    }
  }, [context, patch, service]);
  useEffect(() => {
    void refresh();
    return () => {
      active.current = null;
    };
  }, [refresh, options.revision]);
  const select = async (url: string, selection: string | null) => {
    if (
      !state.snapshot ||
      active.current ||
      !context.ready ||
      !service?.bindRepositoryAuthentication
    )
      return;
    const token = {};
    active.current = token;
    patch({ pending: true, error: null });
    try {
      const snapshot = gitRepositoryAuthenticationSchema.parse(
        await service.bindRepositoryAuthentication({
          ...context.request,
          url,
          selection,
          expectedRevision: state.snapshot.revision,
        }),
      );
      if (active.current === token) patch({ snapshot });
      else if (latest.current === context) await refresh();
    } catch {
      if (active.current === token) patch({ error: "saveFailed" });
    } finally {
      if (active.current === token) {
        active.current = null;
        patch({ pending: false });
      }
    }
  };
  return { ...state, select, refresh, available: Boolean(service?.getRepositoryAuthentication) };
}
