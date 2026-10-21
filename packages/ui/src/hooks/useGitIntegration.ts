import { useCallback, useEffect, useRef, useState } from "react";
import type {
  GitIntegrationPreview,
  GitIntegrationSnapshot,
  GitNetworkSnapshot,
  GitIntegrationMode,
} from "@lcode/shared";
import { useGitOperationSession, type GitOperationScope } from "./useGitOperationSession.js";

type Confirmation =
  | { kind: "start"; preview: GitIntegrationPreview }
  | { kind: "continue" | "abort"; snapshot: GitIntegrationSnapshot };
const initial = {
  snapshot: null as GitIntegrationSnapshot | null,
  refs: [] as string[],
  confirmation: null as Confirmation | null,
};
export function useGitIntegration(props: GitOperationScope) {
  const session = useGitOperationSession(props),
    { context, run, ready } = session;
  const latest = useRef(context);
  latest.current = context;
  const [box, setBox] = useState({ context, ...initial });
  const state = box.context === context ? box : initial;
  const patch = useCallback(
    (values: Partial<typeof initial>) => {
      if (latest.current === context)
        setBox((old) => ({ context, ...(old.context === context ? old : initial), ...values }));
    },
    [context],
  );
  const refresh = useCallback(async () => {
    // 写入丢回执后读事实不能抹掉未知结果提示；刷新不代表该命令已成功。
    const result = await run(
      async (git, scope) =>
        Promise.all([git.getIntegrationSnapshot(scope), git.getNetworkSnapshot(scope)]),
      false,
      true,
    );
    if (result) {
      const [snapshot, network]: [GitIntegrationSnapshot, GitNetworkSnapshot] = result;
      patch({
        snapshot,
        refs: [
          ...network.branches.map((branch) => `refs/heads/${branch.name}`),
          ...network.remoteBranches.map(
            (branch) => `refs/remotes/${branch.remote}/${branch.branch}`,
          ),
        ],
        confirmation: null,
      });
    }
  }, [run, patch]);
  useEffect(() => {
    if (ready) void refresh();
  }, [ready, refresh]);
  return {
    ...state,
    session,
    refresh,
    prepareStart: async (mode: GitIntegrationMode, targetRef: string) => {
      const preview = await run((git, scope) =>
        git.previewIntegration({ ...scope, mode, targetRef }),
      );
      if (preview) patch({ confirmation: { kind: "start", preview } });
    },
    prepareAction: async (kind: "continue" | "abort") => {
      const snapshot = await run((git, scope) => git.getIntegrationSnapshot(scope));
      if (snapshot) patch({ snapshot, confirmation: { kind, snapshot } });
    },
    cancel: () => patch({ confirmation: null }),
    confirm: async (confirmNativeStopped: boolean, confirmDiscard: boolean) => {
      const confirmation = state.confirmation;
      if (!confirmation) return;
      const result = await run((git, scope, requestId) => {
        if (confirmation.kind === "start")
          return git.startIntegration({ ...scope, requestId, preview: confirmation.preview });
        const command = {
          ...scope,
          requestId,
          sourceRequestId: confirmation.snapshot.operation!.requestId,
          expectedRevision: confirmation.snapshot.revision,
          confirmNativeStopped,
          confirmDiscard,
        };
        return confirmation.kind === "abort"
          ? git.abortIntegration(command)
          : git.continueIntegration(command);
      }, true);
      patch({ confirmation: null });
      await refresh();
      return result;
    },
  };
}
