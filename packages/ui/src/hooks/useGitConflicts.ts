import { useEffect, useState } from "react";
import type { GitConflictSnapshot, GitConflictFile, GitNetworkOperation } from "@lcode/shared";
import { useGitOperationSession, type GitOperationScope } from "./useGitOperationSession.js";
import { useGitConflictDraftStore, type GitConflictDraft } from "@/store/gitConflictDraftStore.js";

type Confirmation = { kind: "begin" | "save" | "delete" | "mark"; text?: string };
type Navigation = { path?: string };
const empty = {
  snapshot: null as GitConflictSnapshot | null,
  file: null as GitConflictFile | null,
  owner: null as GitNetworkOperation | null,
  confirmation: null as Confirmation | null,
  navigation: null as Navigation | null,
};
export function useGitConflicts(options: GitOperationScope) {
  const session = useGitOperationSession(options);
  const [box, setBox] = useState({ context: session.context, value: empty });
  const state = box.context === session.context ? box.value : empty;
  const patch = (value: Partial<typeof empty>) =>
    setBox((old) => ({
      context: session.context,
      value: { ...(old.context === session.context ? old.value : empty), ...value },
    }));
  const draftKey = () =>
    JSON.stringify([
      options.workspaceIdentity?.trim() || options.workspacePath,
      options.workspacePath,
      session.context.attachment,
      state.snapshot?.sourceRequestId,
      state.file?.path,
    ]);
  const key = draftKey();
  const record = useGitConflictDraftStore((store) => store.drafts.get(key));
  // 草稿只由 Zustand 所有，Git 读取只更新版本事实；不再维护第二份可编辑文本镜像。
  const draft = record?.text ?? state.file?.result.text ?? "";
  const eol = record?.eol ?? (state.file?.result.eol === "crlf" ? "crlf" : "lf");
  const mixedAccepted = record?.mixedAccepted ?? state.file?.result.eol !== "mixed";
  const dirty = Boolean(record),
    staleDraft = Boolean(record && record.revision !== state.file?.revision);
  const edit = (value: Partial<Omit<GitConflictDraft, "revision">>, useCurrentRevision = false) => {
    if (!state.file) return;
    patch({ confirmation: null });
    useGitConflictDraftStore.getState().put(key, {
      revision: useCurrentRevision
        ? state.file.revision
        : (record?.revision ?? state.file.revision),
      text: value.text ?? draft,
      eol: value.eol ?? eol,
      mixedAccepted: value.mixedAccepted ?? mixedAccepted,
    });
  };
  const read = async (path?: string) => {
    const value = await session.run(async (git, scope) => {
      const snapshot = await git.getConflictSnapshot(scope);
      const index = Math.max(0, state.snapshot?.files.findIndex((file) => file.path === path) ?? 0);
      const selected =
        snapshot.files.find((file) => file.path === path) ??
        snapshot.files[Math.min(index, snapshot.files.length - 1)];
      const [file, owner] = await Promise.all([
        selected ? git.getConflictFile({ ...scope, path: selected.path }) : null,
        snapshot.sourceRequestId
          ? git.getNetworkOperation({ ...scope, requestId: snapshot.sourceRequestId })
          : null,
      ]);
      return { snapshot, file, owner };
    });
    if (value) patch({ ...value, confirmation: null, navigation: null });
  };
  useEffect(() => {
    void read();
  }, [session.context, session.ready]);
  const navigate = (path?: string) => {
    if (dirty) patch({ navigation: { path }, confirmation: null });
    else void read(path ?? state.file?.path);
  };
  return {
    ...state,
    draft,
    eol,
    mixedAccepted,
    dirty,
    staleDraft,
    session,
    refresh: () => navigate(),
    select: (path: string) => navigate(path),
    discardAndNavigate: () => {
      if (state.navigation) {
        useGitConflictDraftStore.getState().put(key, null);
        void read(state.navigation.path ?? state.file?.path);
      }
    },
    keepDraft: () => patch({ navigation: null }),
    edit: (text: string) => edit({ text }),
    setEol: (eol: "lf" | "crlf") => edit({ eol, mixedAccepted: true }),
    useVersion: (version: "base" | "ours" | "theirs") => {
      const value = state.file?.[version];
      if (value?.kind === "text")
        edit(
          {
            text: value.text!,
            eol: value.eol === "crlf" ? "crlf" : "lf",
            mixedAccepted: value.eol !== "mixed",
          },
          true,
        );
    },
    prepare: (kind: Confirmation["kind"]) => {
      if (!session.pending && !(kind === "save" && staleDraft))
        patch({
          confirmation: {
            kind,
            ...(kind === "save"
              ? {
                  text: draft
                    .replace(/\r\n|\r/g, "\n")
                    .replaceAll("\n", eol === "crlf" ? "\r\n" : "\n"),
                }
              : {}),
          },
        });
    },
    cancel: () => patch({ confirmation: null }),
    confirm: async (confirmNativeStopped: boolean, confirmSpecial: boolean) => {
      const confirmation = state.confirmation,
        snapshot = state.snapshot,
        file = state.file;
      if (!confirmation || !snapshot) return;
      const result = await session.run((git, scope, requestId) => {
        if (confirmation.kind === "begin")
          return git.beginConflictResolution({
            ...scope,
            requestId,
            expectedRevision: snapshot.revision,
          });
        if (!file || !snapshot.sourceRequestId) throw new Error("missing-operation");
        const command = {
          ...scope,
          requestId,
          sourceRequestId: snapshot.sourceRequestId,
          path: file.path,
          expectedRevision: file.revision,
          confirmNativeStopped,
        };
        return confirmation.kind === "mark"
          ? git.markConflictResolved({ ...command, confirmSpecial })
          : git.saveConflictResult({
              ...command,
              action: confirmation.kind,
              ...(confirmation.kind === "save" ? { text: confirmation.text! } : {}),
            });
      }, true);
      if (
        result &&
        (result.status === "success" ||
          (confirmation.kind === "begin" && result.status === "conflict"))
      ) {
        useGitConflictDraftStore.getState().put(key, null);
        await read(file?.path);
      }
    },
  };
}
export type GitConflictsController = ReturnType<typeof useGitConflicts>;
