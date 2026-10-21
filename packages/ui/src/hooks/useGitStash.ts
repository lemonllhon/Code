import { useEffect, useState } from "react";
import type {
  GitStashSnapshot,
  GitStashPreview,
  GitStashEntry,
  GitPublishState,
} from "@lcode/shared";
import { useGitOperationSession, type GitOperationScope } from "./useGitOperationSession.js";

type Confirmation =
  | {
      kind: "save";
      revision: string;
      expectedState: GitPublishState;
      includeUntracked: boolean;
      message: string;
      root: string;
      files: string[];
    }
  | {
      kind: "apply";
      entry: GitStashEntry;
      revision: string;
      expectedState: GitPublishState;
      restoreIndex: boolean;
    }
  | { kind: "drop"; entry: GitStashEntry; revision: string };
const empty = {
  snapshot: null as GitStashSnapshot | null,
  preview: null as GitStashPreview | null,
  confirmation: null as Confirmation | null,
};
export function useGitStash(options: GitOperationScope) {
  const session = useGitOperationSession(options);
  const [box, setBox] = useState({ context: session.context, state: empty });
  const state = box.context === session.context ? box.state : empty;
  const patch = (value: Partial<typeof empty>) =>
    setBox((old) => ({
      context: session.context,
      state: { ...(old.context === session.context ? old.state : empty), ...value },
    }));
  const refresh = async () => {
    const snapshot = await session.run((git, scope) => git.getStashSnapshot(scope));
    if (snapshot) patch({ snapshot, preview: null, confirmation: null });
  };
  useEffect(() => {
    void refresh();
  }, [session.context, session.ready]);
  const revision = state.snapshot?.revision;
  return {
    ...state,
    session,
    refresh,
    previewEntry: async (entry: GitStashEntry) => {
      if (!revision) return;
      const preview = await session.run((git, scope) =>
        git.previewStash({ ...scope, expectedRevision: revision, oid: entry.oid }),
      );
      if (preview) patch({ preview, confirmation: null });
    },
    prepareSave: async (includeUntracked: boolean, message: string) => {
      if (!revision) return;
      const prepared = await session.run((git, scope) =>
        git.previewStashSave({ ...scope, includeUntracked }),
      );
      if (prepared)
        patch({ confirmation: { kind: "save", includeUntracked, message, ...prepared } });
    },
    prepareApply: async (entry: GitStashEntry, restoreIndex: boolean) => {
      if (!revision) return;
      const expectedState = await session.run((git, scope) => git.getPublishState(scope));
      if (expectedState)
        patch({ confirmation: { kind: "apply", entry, revision, expectedState, restoreIndex } });
    },
    prepareDrop: (entry: GitStashEntry) => {
      if (revision && !session.pending) patch({ confirmation: { kind: "drop", entry, revision } });
    },
    cancel: () => {
      if (!session.pending) patch({ confirmation: null });
    },
    confirm: async () => {
      const confirmation = state.confirmation;
      if (!confirmation) return;
      const result = await session.run((git, scope, requestId) => {
        const base = { ...scope, requestId, expectedRevision: confirmation.revision };
        if (confirmation.kind === "save")
          return git.saveStash({
            ...base,
            expectedState: confirmation.expectedState,
            includeUntracked: confirmation.includeUntracked,
            message: confirmation.message,
          });
        if (confirmation.kind === "apply")
          return git.applyStash({
            ...base,
            oid: confirmation.entry.oid,
            expectedState: confirmation.expectedState,
            restoreIndex: confirmation.restoreIndex,
          });
        return git.dropStash({
          ...base,
          oid: confirmation.entry.oid,
          selector: confirmation.entry.selector,
        });
      }, true);
      if (result) await refresh();
    },
  };
}
