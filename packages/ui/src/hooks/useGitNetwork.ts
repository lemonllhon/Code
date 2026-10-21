import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  GitFastForwardPreview,
  GitNetworkOperation,
  GitNetworkSnapshot,
  GitRemoteMutationRequest,
  GitTrackingRequest,
} from "@lcode/shared";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { gitRemoteMutationRequestSchema } from "@lcode/shared";

type Confirmation =
  | {
      kind: "remote";
      params: Omit<GitRemoteMutationRequest, "workspacePath" | "workspaceIdentity" | "requestId">;
    }
  | {
      kind: "tracking";
      params: Omit<GitTrackingRequest, "workspacePath" | "workspaceIdentity" | "requestId">;
    }
  | { kind: "fast-forward"; preview: GitFastForwardPreview };
interface State {
  snapshot: GitNetworkSnapshot | null;
  receipt: GitNetworkOperation | null;
  confirmation: Confirmation | null;
  pending: boolean;
  error: string | null;
}
const empty: State = {
  snapshot: null,
  receipt: null,
  confirmation: null,
  pending: false,
  error: null,
};

/** UI 只保留草稿和请求关联；恢复时查询原收据，绝不重放网络命令。 */
export function useGitNetwork(options: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  onRefresh?: () => void;
}) {
  const resolution = useWorkspaceServicesResolution(
    options.workspacePath,
    options.workspaceRemoteSessionId,
    options.workspaceIdentity,
  );
  const service = resolution.services.gitService;
  const identity = options.workspaceIdentity?.trim() || undefined;
  const context = useMemo(
    () => ({
      service,
      remoteSessionId: resolution.remoteSessionId,
      request: { workspacePath: options.workspacePath, workspaceIdentity: identity },
      storageKey: `lcode:git-network:${identity || options.workspacePath}`,
    }),
    [service, resolution.remoteSessionId, options.workspacePath, identity],
  );
  const latest = useRef<typeof context | null>(context);
  latest.current = context;
  const active = useRef<object | null>(null);
  const [value, setValue] = useState<{ context: typeof context; data: State }>({
    context,
    data: empty,
  });
  const state = value.context === context ? value.data : empty;
  const patch = useCallback(
    (data: Partial<State>) => {
      if (latest.current === context)
        setValue((old) => ({
          context,
          data: { ...(old.context === context ? old.data : empty), ...data },
        }));
    },
    [context],
  );
  const refresh = useCallback(async () => {
    if (!resolution.rpcReady) return;
    const token = {};
    active.current = token;
    patch({ pending: true, error: null, confirmation: null });
    try {
      const snapshot = await service.getNetworkSnapshot(context.request);
      let requestId: string | null = null;
      try {
        requestId = sessionStorage.getItem(context.storageKey);
      } catch {
        /* storage unavailable */
      }
      const receipt = requestId
        ? await service.getNetworkOperation({ ...context.request, requestId })
        : null;
      if (active.current === token) patch({ snapshot, receipt });
    } catch {
      if (active.current === token) patch({ error: "read-failed" });
    } finally {
      if (active.current === token) {
        active.current = null;
        patch({ pending: false });
      }
    }
  }, [context, service, patch, resolution.rpcReady]);
  useEffect(() => {
    latest.current = context;
    void refresh();
    return () => {
      latest.current = null;
      active.current = null;
    };
  }, [context, refresh]);
  const execute = async (
    action: () => Promise<GitNetworkOperation | GitFastForwardPreview>,
    preparing = false,
  ) => {
    if (!resolution.rpcReady || active.current || latest.current !== context) return;
    const token = {};
    active.current = token;
    patch({ pending: true, error: null, confirmation: null });
    try {
      const result = await action();
      if (latest.current !== context || active.current !== token) return;
      if ("reason" in result) patch({ confirmation: { kind: "fast-forward", preview: result } });
      else {
        patch({ receipt: result });
        patch({ snapshot: await service.getNetworkSnapshot(context.request) });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      patch({
        error:
          message.includes("LCODE_CHECKOUT_BUSY") || message.includes("Checkout is busy")
            ? "checkout-busy"
            : preparing
              ? "read-failed"
              : "outcome-unknown",
      });
    } finally {
      if (active.current === token) {
        active.current = null;
        patch({ pending: false });
        // 与现有工作台共用刷新入口；网络命令结算后仅重新读取本地事实。
        if (!preparing && latest.current === context) options.onRefresh?.();
      }
    }
  };
  const command = () => {
    const requestId = crypto.randomUUID();
    try {
      sessionStorage.setItem(context.storageKey, requestId);
    } catch {
      /* storage unavailable */
    }
    return { ...context.request, requestId, expectedRevision: state.snapshot!.revision };
  };
  return {
    ...state,
    ready: resolution.rpcReady && Boolean(state.snapshot) && !state.pending,
    refresh: () => {
      if (!active.current) void refresh();
    },
    prepareRemote: (
      params: Omit<
        GitRemoteMutationRequest,
        "workspacePath" | "workspaceIdentity" | "requestId" | "expectedRevision"
      >,
    ) => {
      if (!active.current && state.snapshot) {
        if (
          !gitRemoteMutationRequestSchema.safeParse({
            ...context.request,
            ...params,
            expectedRevision: state.snapshot.revision,
            requestId: "preview",
          }).success
        ) {
          patch({ error: "invalid-input" });
          return;
        }
        patch({
          confirmation: {
            kind: "remote",
            params: { ...params, expectedRevision: state.snapshot.revision },
          },
        });
      }
    },
    prepareTracking: (upstream: GitTrackingRequest["upstream"]) => {
      if (!active.current && state.snapshot?.branch)
        patch({
          confirmation: {
            kind: "tracking",
            params: {
              branch: state.snapshot.branch,
              upstream,
              expectedRevision: state.snapshot.revision,
            },
          },
        });
    },
    preview: () => {
      void execute(() => service.previewFastForward(context.request), true);
    },
    fetch: (remotes: string[]) => {
      if (state.snapshot && remotes.length)
        void execute(() => service.fetchRemotes({ ...command(), remotes }));
    },
    cancel: () => {
      if (!active.current) patch({ confirmation: null });
    },
    confirm: () => {
      const confirmation = state.confirmation;
      if (!confirmation || !state.snapshot) return;
      void execute(() => {
        const request = command();
        if (confirmation.kind === "remote")
          return service.mutateRemote({ ...request, ...confirmation.params });
        if (confirmation.kind === "tracking")
          return service.setBranchTracking({ ...request, ...confirmation.params });
        return service.fastForward({
          ...request,
          expectedRevision: confirmation.preview.revision,
          preview: confirmation.preview,
        });
      });
    },
  };
}
