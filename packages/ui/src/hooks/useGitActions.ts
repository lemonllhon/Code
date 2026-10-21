import { useEffect, useMemo, useRef, useState } from "react";
import type { GitChangeSourceId, GitPublishState } from "@lcode/shared";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

export type GitFileAction = "stage" | "unstage" | "discard";
interface DiscardConfirmation {
  paths: string[];
  staged: boolean;
  expectedState: GitPublishState;
}

/** 只持有本地交互状态；成功与失败都刷新 Git 事实，不乐观修改文件列表。 */
export function useGitActions(options: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  sourceId: GitChangeSourceId;
  enabled: boolean;
  onRefresh: () => void;
}) {
  const resolution = useWorkspaceServicesResolution(
    options.workspacePath,
    options.workspaceRemoteSessionId,
    options.workspaceIdentity,
  );
  const gitService = resolution.services.gitService;
  const identity = options.workspaceIdentity?.trim() || undefined;
  const available =
    options.enabled &&
    resolution.rpcReady &&
    (options.sourceId === "staged" || options.sourceId === "unstaged");
  const context = useMemo(
    () => ({
      request: { workspacePath: options.workspacePath, workspaceIdentity: identity },
      sourceId: options.sourceId,
      gitService,
      remoteSessionId: resolution.remoteSessionId,
    }),
    [options.workspacePath, identity, options.sourceId, gitService, resolution.remoteSessionId],
  );
  const enabled = useRef(available);
  enabled.current = available;
  const latest = useRef<typeof context | null>(context);
  latest.current = context;
  const active = useRef<object | null>(null);
  const [state, setState] = useState<{
    context: typeof context;
    pending: boolean;
    error: string | null;
    confirmation: DiscardConfirmation | null;
  }>({ context, pending: false, error: null, confirmation: null });
  const current =
    state.context === context ? state : { pending: false, error: null, confirmation: null };
  useEffect(() => {
    latest.current = context;
    return () => {
      latest.current = null;
      active.current = null;
    };
  }, [context]);

  const execute = async (
    action: GitFileAction,
    paths: string[],
    confirmed?: DiscardConfirmation,
  ) => {
    if (latest.current !== context || !available || !paths.length || active.current) return;
    if (
      (action === "stage" && context.sourceId !== "unstaged") ||
      (action === "unstage" && context.sourceId !== "staged")
    )
      return;
    const token = {};
    active.current = token;
    setState({ context, pending: true, error: null, confirmation: null });
    const isCurrent = () => latest.current === context && active.current === token;
    let shouldRefresh = action !== "discard" || Boolean(confirmed);
    try {
      const expectedState =
        confirmed?.expectedState ?? (await gitService.getPublishState(context.request));
      if (!isCurrent() || !enabled.current) return;
      const request = { ...context.request, paths: [...new Set(paths)], expectedState };
      if (action === "discard" && !confirmed) {
        shouldRefresh = false;
        setState({
          context,
          pending: false,
          error: null,
          confirmation: { ...request, staged: context.sourceId === "staged" },
        });
      } else if (action === "discard") {
        await gitService.discardPaths({ ...request, staged: confirmed!.staged });
      } else if (action === "stage") {
        await gitService.stagePaths(request);
      } else {
        await gitService.unstagePaths(request);
      }
    } catch (error) {
      if (isCurrent()) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[GitPane] 文件操作失败", { action, count: paths.length, error: message });
        setState({ context, pending: false, error: message, confirmation: null });
      }
    } finally {
      if (isCurrent()) {
        active.current = null;
        setState((value) => (value.context === context ? { ...value, pending: false } : value));
        if (shouldRefresh) options.onRefresh();
      }
    }
  };

  return {
    gitService,
    available,
    ...current,
    run: (action: GitFileAction, paths: string[]) => {
      void execute(action, paths);
    },
    cancelDiscard: () => setState({ context, pending: false, error: null, confirmation: null }),
    confirmDiscard: () => {
      if (current.confirmation)
        void execute("discard", current.confirmation.paths, current.confirmation);
    },
  };
}
