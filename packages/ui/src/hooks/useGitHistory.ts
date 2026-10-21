import { useCallback, useEffect, useRef, useState } from "react";
import type {
  GitHistoryPage,
  GitHistoryDetail,
  GitHistoryFile,
  GitHistoryTagPreview,
  GitHistoryTagInfo,
  GitHistoryRequest,
  GitIntegrationPreview,
  GitHistoryCandidates,
  GitHistoryResetPreview,
} from "@lcode/shared";
import { useGitOperationSession, type GitOperationScope } from "./useGitOperationSession.js";
type Filters = Pick<
  GitHistoryRequest,
  "ref" | "author" | "search" | "since" | "until" | "searchMode" | "caseSensitive"
>;
type Confirmation =
  | { kind: "action"; preview: GitIntegrationPreview }
  | { kind: "tag"; preview: GitHistoryTagPreview }
  | { kind: "reset"; preview: GitHistoryResetPreview };
const initial = {
  page: null as GitHistoryPage | null,
  detail: null as GitHistoryDetail | null,
  file: null as GitHistoryFile | null,
  filters: {} as Filters,
  confirmation: null as Confirmation | null,
  tagInfo: null as GitHistoryTagInfo | null,
  candidates: null as GitHistoryCandidates | null,
};
export function useGitHistory(props: GitOperationScope & { onIntegrate?: () => void }) {
  const session = useGitOperationSession(props),
    { context, ready, run } = session;
  const current = useRef(context);
  current.current = context;
  const [box, setBox] = useState({ context, ...initial }),
    state = box.context === context ? box : initial;
  const patch = useCallback(
    (values: Partial<typeof initial>) => {
      if (current.current === context)
        setBox((old) => ({ context, ...(old.context === context ? old : initial), ...values }));
    },
    [context],
  );
  const refresh = useCallback(
    async (filters: Filters = {}) => {
      const result = await run(
        (git, scope) => git.getHistory({ ...scope, ...filters }),
        false,
        true,
      );
      if (result)
        patch({
          page: result,
          filters,
          detail: null,
          file: null,
          confirmation: null,
          candidates: null,
        });
    },
    [run, patch],
  );
  useEffect(() => {
    if (ready) void refresh();
  }, [refresh, ready]);
  return {
    ...state,
    session,
    refresh,
    locate: async (target: string) => {
      const value = await run(
        async (git, scope) => {
          const { hash } = await git.locateHistoryCommit({ ...scope, target });
          const page = await git.getHistory({ ...scope, ref: hash });
          const detail = await git.getHistoryDetail({ ...scope, hash });
          return { page, detail, filters: { ref: hash } };
        },
        false,
        true,
      );
      if (value) patch({ ...value, file: null, confirmation: null, candidates: null });
      return Boolean(value);
    },
    clearFile: () => patch({ file: null, confirmation: null }),
    loadCandidates: async () => {
      const candidates = await run((git, scope) => git.getHistoryCandidates(scope), false, true);
      if (candidates) patch({ candidates });
    },
    more: async () => {
      if (!state.page?.hasMore || state.page.commits.length > 10000) return;
      const page = await run((git, scope) =>
        git.getHistory({
          ...scope,
          ...state.filters,
          skip: state.page!.commits.length,
          expectedRevision: state.page!.revision,
        }),
      );
      if (page) patch({ page: { ...page, commits: [...state.page.commits, ...page.commits] } });
    },
    select: async (hash: string, parent = 1) => {
      patch({ file: null, confirmation: null, tagInfo: null });
      const detail = await run((git, scope) => git.getHistoryDetail({ ...scope, hash, parent }));
      if (detail) patch({ detail });
    },
    selectFile: async (path: string) => {
      if (!state.detail) return;
      patch({ file: null });
      const file = await run((git, scope) =>
        git.getHistoryFile({
          ...scope,
          hash: state.detail!.hash,
          parent: state.detail!.parent,
          path,
        }),
      );
      if (file) patch({ file });
    },
    prepareAction: async (
      mode: "cherry-pick" | "revert",
      hash = state.detail?.hash,
      mainline?: number,
      targets?: string[],
    ) => {
      if (!hash) return;
      const result = await run(async (git, scope) => {
        const detail =
          state.detail?.hash === hash
            ? state.detail
            : await git.getHistoryDetail({ ...scope, hash });
        const preview = await git.previewIntegration({
          ...scope,
          mode,
          targetRef: hash,
          mainline,
          targets,
        });
        return { detail, preview };
      });
      if (result)
        patch({
          detail: result.detail,
          file: state.detail?.hash === hash ? state.file : null,
          confirmation: { kind: "action", preview: result.preview },
        });
    },
    prepareTag: async (name: string, message: string, signed: boolean) => {
      if (!state.detail) return;
      const preview = await run((git, scope) =>
        git.previewHistoryTag({ ...scope, hash: state.detail!.hash, name, message, signed }),
      );
      if (preview) patch({ confirmation: { kind: "tag", preview } });
    },
    prepareReset: async (mode: "soft" | "mixed" | "hard") => {
      if (!state.detail) return;
      const preview = await run((git, scope) =>
        git.previewHistoryReset({ ...scope, target: state.detail!.hash, mode }),
      );
      if (preview) patch({ confirmation: { kind: "reset", preview } });
    },
    prepareResetRecovery: async () => {
      if (!session.receipt) return;
      const preview = await run((git, scope) =>
        git.previewHistoryResetRecovery({ ...scope, requestId: session.receipt!.requestId }),
      );
      if (preview) patch({ confirmation: { kind: "reset", preview } });
    },
    cancel: () => patch({ confirmation: null }),
    inspectTag: async (name: string) => {
      const tagInfo = await run((git, scope) => git.getHistoryTag({ ...scope, name }), false, true);
      if (tagInfo) patch({ tagInfo });
    },
    confirm: async (confirmDiscard = false) => {
      const confirmation = state.confirmation;
      if (!confirmation) return;
      const receipt = await run(
        (git, scope, requestId) =>
          confirmation.kind === "reset"
            ? git.resetHistory({
                ...scope,
                requestId,
                preview: confirmation.preview,
                confirmDiscard,
              })
            : confirmation.kind === "tag"
              ? git.createHistoryTag({ ...scope, requestId, preview: confirmation.preview })
              : git.startIntegration({ ...scope, requestId, preview: confirmation.preview }),
        true,
      );
      patch({ confirmation: null });
      if (receipt && current.current === context) {
        if (confirmation.kind === "action" && receipt.status !== "failed") props.onIntegrate?.();
        else if (receipt.status === "success") await refresh(state.filters);
      }
    },
  };
}
export type GitHistoryController = ReturnType<typeof useGitHistory>;
