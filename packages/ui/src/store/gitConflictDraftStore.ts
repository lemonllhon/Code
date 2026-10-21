import { create } from "zustand";
export interface GitConflictDraft {
  revision: string;
  text: string;
  eol: "lf" | "crlf";
  mixedAccepted: boolean;
}
interface State {
  drafts: ReadonlyMap<string, GitConflictDraft>;
  put: (key: string, draft: GitConflictDraft | null) => void;
}
/** 窗口内未提交文本；不落盘、不保存人工授权或任何已接受命令。 */
export const useGitConflictDraftStore = create<State>((set) => ({
  drafts: new Map(),
  put: (key, draft) =>
    set((state) => {
      // 对象数字键会重排，导致旧草稿挤掉新草稿；Map 保留实际编辑顺序。
      const next = new Map(state.drafts);
      next.delete(key);
      if (draft) next.set(key, draft);
      if (next.size > 20) next.delete(next.keys().next().value!);
      return { drafts: next };
    }),
}));
