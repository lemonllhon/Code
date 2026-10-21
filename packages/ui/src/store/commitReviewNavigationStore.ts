import { create } from "zustand";

export function commitReviewNavigationKey(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  sessionId: string,
) {
  return JSON.stringify([workspaceIdentity?.trim() || workspacePath, sessionId]);
}

interface NavigationRequest {
  key: string;
  token: string;
}
export type GitWorkbenchView =
  | "review"
  | "changes"
  | "graph"
  | "network"
  | "stash"
  | "conflicts"
  | "integration";
interface PaneNavigation {
  token: string;
  open: () => void;
  close: () => void;
  selectView: (view: GitWorkbenchView) => void;
}
interface PaneHost {
  token: string;
  element: HTMLElement;
  visible: boolean;
}
interface CommitReviewNavigationState {
  paneNavigation: Record<string, PaneNavigation>;
  registerPaneNavigation: (key: string, value: PaneNavigation) => void;
  removePaneNavigation: (key: string, token: string) => void;
  revealPane: (key: string) => boolean;
  paneHosts: Record<string, PaneHost>;
  registerPaneHost: (key: string, value: PaneHost) => void;
  setPaneHostVisible: (key: string, token: string, visible: boolean) => void;
  removePaneHost: (key: string, token: string) => void;
  publicationHosts: Record<string, PaneHost>;
  registerPublicationHost: (key: string, value: PaneHost) => void;
  removePublicationHost: (key: string, token: string) => void;
  draftReceivers: Record<string, { token: string; action: (text: string) => boolean | void }>;
  registerDraftReceiver: (
    key: string,
    receiver: { token: string; action: (text: string) => boolean | void },
  ) => void;
  removeDraftReceiver: (key: string, token: string) => void;
  transferDraft: (key: string, text: string) => boolean;
  resolvers: Record<string, { token: string; action: (operationId: string) => Promise<void> }>;
  registerResolver: (
    key: string,
    resolver: { token: string; action: (operationId: string) => Promise<void> },
  ) => void;
  removeResolver: (key: string, token: string) => void;
  request: NavigationRequest | null;
  open: (key: string) => void;
  consume: (key: string) => boolean;
  cancel: () => void;
}

// 只保存窗口内尚未消费的“打开界面”意图，不能作为提交、合并或人工审批事实。
export const useCommitReviewNavigationStore = create<CommitReviewNavigationState>((set, get) => ({
  paneNavigation: {},
  registerPaneNavigation: (key, value) =>
    set((state) => ({ paneNavigation: { ...state.paneNavigation, [key]: value } })),
  removePaneNavigation: (key, token) => {
    if (get().paneNavigation[key]?.token !== token) return;
    const { [key]: removed, ...paneNavigation } = get().paneNavigation;
    void removed;
    set({ paneNavigation });
  },
  revealPane: (key) => {
    const navigation = get().paneNavigation[key];
    if (!navigation) return false;
    navigation.open();
    return true;
  },
  paneHosts: {},
  registerPaneHost: (key, value) =>
    set((state) => ({ paneHosts: { ...state.paneHosts, [key]: value } })),
  setPaneHostVisible: (key, token, visible) => {
    const host = get().paneHosts[key];
    if (!host || host.token !== token || host.visible === visible) return;
    set((state) => ({ paneHosts: { ...state.paneHosts, [key]: { ...host, visible } } }));
  },
  removePaneHost: (key, token) => {
    if (get().paneHosts[key]?.token !== token) return;
    const { [key]: removed, ...paneHosts } = get().paneHosts;
    void removed;
    set({ paneHosts });
  },
  publicationHosts: {},
  registerPublicationHost: (key, value) =>
    set((state) => ({ publicationHosts: { ...state.publicationHosts, [key]: value } })),
  removePublicationHost: (key, token) => {
    if (get().publicationHosts[key]?.token !== token) return;
    const { [key]: removed, ...publicationHosts } = get().publicationHosts;
    void removed;
    set({ publicationHosts });
  },
  draftReceivers: {},
  registerDraftReceiver: (key, receiver) =>
    set((state) => ({ draftReceivers: { ...state.draftReceivers, [key]: receiver } })),
  removeDraftReceiver: (key, token) => {
    if (get().draftReceivers[key]?.token !== token) return;
    const { [key]: removed, ...draftReceivers } = get().draftReceivers;
    void removed;
    set({ draftReceivers });
  },
  transferDraft: (key, text) => {
    const receiver = get().draftReceivers[key];
    if (!receiver) return false;
    return receiver.action(text) !== false;
  },
  resolvers: {},
  registerResolver: (key, resolver) =>
    set((state) => ({ resolvers: { ...state.resolvers, [key]: resolver } })),
  removeResolver: (key, token) => {
    if (get().resolvers[key]?.token !== token) return;
    const { [key]: removed, ...resolvers } = get().resolvers;
    void removed;
    set({ resolvers });
  },
  request: null,
  open: (key) => set({ request: { key, token: crypto.randomUUID() } }),
  consume: (key) => {
    if (get().request?.key !== key) return false;
    set({ request: null });
    return true;
  },
  cancel: () => set({ request: null }),
}));
