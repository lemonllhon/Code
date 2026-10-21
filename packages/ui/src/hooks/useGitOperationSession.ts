import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IGitService } from "@lcode/services";
import type {
  GitRepositoryRequest,
  GitNetworkOperation,
  GitCompleteOperationPreview,
} from "@lcode/shared";
import { gitNetworkOperationSchema } from "@lcode/shared";
import {
  useWorkspaceServicesResolution,
  useBaseWorkspaceServices,
} from "@/hooks/useWorkspaceServices.js";

export interface GitOperationScope {
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  onRefresh?: () => void;
  useBaseHost?: boolean;
}
const initial = {
  pending: false,
  error: null as string | null,
  receipt: null as GitNetworkOperation | null,
  recovery: null as GitCompleteOperationPreview | null,
  mutationRequestId: null as string | null,
};
const knownErrors = [
  "stale-account",
  "missing-account",
  "account-server-mismatch",
  "authentication-unavailable",
  "ssh-key-unavailable",
  "stale-history",
  "invalid-history-regex",
  "ambiguous-history-target",
  "missing-history-target",
  "reset-outcome-unknown",
  "history-read-failed",
  "history-object-too-large",
  "unsupported-history-object",
  "invalid-parent",
  "missing-history-file",
  "mainline-required",
  "unreachable-commit",
  "tag-exists",
  "signer-not-configured",
  "tag-command-failed",
  "tag-outcome-unknown",
  "dirty-checkout",
  "detached",
  "unborn",
  "invalid-target",
  "unsupported-checkout",
  "unsupported-integration",
  "unsupported-rebase-topology",
  "unrelated-histories",
  "ignored-collision",
  "discard-confirmation-required",
  "integration-not-ready",
  "operation-in-progress",
  "stale-conflict",
  "unsupported-conflict",
  "missing-conflict",
  "native-check-required",
  "invalid-conflict",
  "stale-preview",
  "invalid-directory",
  "target-exists",
  "already-repository",
  "nested-repository",
  "missing-operation",
  "checkout-reserved",
  "stale-recovery",
  "unsupported-stash-storage",
  "missing-stash",
  "git-lock-busy",
];

/** 只保留请求关联和本地交互；恢复只查收据，不重放已接受命令。 */
export function useGitOperationSession(options: GitOperationScope) {
  const resolution = useWorkspaceServicesResolution(
    options.workspacePath,
    options.workspaceRemoteSessionId,
    options.workspaceIdentity,
  );
  const baseServices = useBaseWorkspaceServices();
  const services = options.useBaseHost ? baseServices : resolution.services;
  const service = services.gitService;
  const attachment = options.useBaseHost ? null : resolution.remoteSessionId;
  const identity = options.workspaceIdentity?.trim() || undefined;
  const context = useMemo(
    () => ({
      service,
      attachment,
      request: { workspacePath: options.workspacePath ?? "", workspaceIdentity: identity },
      storageKey: `lcode:git-workspace-operation:${identity || options.workspacePath || ""}`,
    }),
    [service, attachment, options.workspacePath, identity],
  );
  const latest = useRef<typeof context | null>(context);
  latest.current = context;
  const active = useRef<object | null>(null);
  const [stored, setStored] = useState({ context, state: initial });
  const state = stored.context === context ? stored.state : initial;
  const patch = useCallback(
    (value: Partial<typeof initial>) => {
      if (latest.current === context)
        setStored((old) => ({
          context,
          state: { ...(old.context === context ? old.state : initial), ...value },
        }));
    },
    [context],
  );
  const ready = (options.useBaseHost || resolution.rpcReady) && Boolean(options.workspacePath);
  const run = useCallback(
    async <T>(
      job: (git: IGitService, scope: GitRepositoryRequest, requestId: string) => Promise<T>,
      mutation = false,
      preserveError = false,
    ): Promise<T | undefined> => {
      if (!ready || active.current || latest.current !== context) return;
      const token = {};
      active.current = token;
      const requestId = crypto.randomUUID();
      // 中文依据：保留的旧收据不能代表新请求；先记录本次关联 ID，丢回执后也只能核对这一请求。
      patch({
        pending: true,
        ...(mutation ? { mutationRequestId: requestId } : {}),
        ...(preserveError ? {} : { error: null }),
      });
      if (mutation) {
        try {
          sessionStorage.setItem(context.storageKey, requestId);
        } catch {
          /* storage unavailable */
        }
      }
      try {
        const value = await job(service, context.request, requestId);
        if (latest.current !== context || active.current !== token) return;
        if (mutation) {
          const receipt = gitNetworkOperationSchema.safeParse(value);
          if (receipt.success) patch({ receipt: receipt.data, recovery: null });
        }
        return value;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        patch({
          error: message.includes("LCODE_CHECKOUT_BUSY")
            ? "checkout-busy"
            : message.includes("LCODE_CHECKOUT_RESERVED")
              ? "checkout-reserved"
              : (knownErrors.find((code) => message.includes(code)) ??
                (mutation ? "outcome-unknown" : "read-failed")),
        });
      } finally {
        if (active.current === token) {
          active.current = null;
          patch({ pending: false });
          if (mutation && latest.current === context) options.onRefresh?.();
        }
      }
    },
    [ready, context, service, patch, options.onRefresh],
  );
  const loadReceipt = useCallback(async () => {
    let requestId: string | null = null;
    try {
      requestId = sessionStorage.getItem(context.storageKey);
    } catch {
      /* storage unavailable */
    }
    if (!requestId) return;
    if (!ready) return;
    try {
      const receipt = await service.getNetworkOperation({ ...context.request, requestId });
      if (receipt && latest.current === context) patch({ receipt });
    } catch {
      patch({ error: "read-failed" });
    }
  }, [context, ready, service, patch]);
  useEffect(() => {
    latest.current = context;
    void loadReceipt();
    return () => {
      latest.current = null;
      active.current = null;
    };
  }, [context, ready]);
  return {
    ...state,
    context,
    services,
    isRemote: !options.useBaseHost && resolution.isRemoteTarget,
    ready,
    run,
    loadReceipt,
    clearError: () => patch({ error: null }),
    reportError: (error: string) => patch({ error }),
    prepareRecovery: async (sourceRequestId: string) => {
      const recovery = await run((git, scope) =>
        git.previewGitOperationCompletion({ ...scope, requestId: sourceRequestId }),
      );
      if (recovery) patch({ recovery });
    },
    cancelRecovery: () => {
      if (!active.current) patch({ recovery: null });
    },
    completeRecovery: async (confirmNativeStopped: boolean) => {
      if (!state.recovery) return;
      const preview = state.recovery;
      return run(
        (git, scope, requestId) =>
          git.completeGitOperation({
            ...scope,
            requestId,
            sourceRequestId: preview.sourceRequestId,
            expectedRevision: preview.revision,
            confirmNativeStopped,
          }),
        true,
      );
    },
  };
}
export type GitOperationSession = ReturnType<typeof useGitOperationSession>;
