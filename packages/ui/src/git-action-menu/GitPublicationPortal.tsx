import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useCommitReviewNavigationStore } from "@/store/commitReviewNavigationStore.js";

const PublicationScopeContext = createContext<{ scope: string; onInteraction: () => void } | null>(
  null,
);

export function useGitPublicationNavigation() {
  const scope = useContext(PublicationScopeContext)?.scope;
  return scope
    ? (view: "review" | "network") => {
        const store = useCommitReviewNavigationStore.getState();
        store.paneNavigation[scope]?.selectView(view);
        if (view === "review") store.open(scope);
      }
    : null;
}

export function GitPublicationScope({
  scope,
  onInteraction,
  children,
}: {
  scope: string;
  onInteraction: () => void;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ scope, onInteraction }), [scope, onInteraction]);
  return (
    <PublicationScopeContext.Provider value={value}>{children}</PublicationScopeContext.Provider>
  );
}

export function GitPublicationHost({ scope, visible }: { scope: string; visible: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!element.current) return;
    const store = useCommitReviewNavigationStore.getState();
    const token = crypto.randomUUID();
    store.registerPublicationHost(scope, { token, element: element.current, visible });
    // 远端页重挂载时只替换 DOM host；旧 cleanup 不能移除新会话的发布插槽。
    return () => store.removePublicationHost(scope, token);
  }, [scope, visible]);
  return <div ref={element} data-testid="git-network-publication-host" />;
}

export function GitPublicationPortal({ children }: { children: ReactNode }) {
  const context = useContext(PublicationScopeContext);
  const scope = context?.scope;
  const host = useCommitReviewNavigationStore((state) =>
    scope ? state.publicationHosts[scope] : undefined,
  );
  // 提交审核内的来源/目标发布只移动展示；独立工作树管理仍使用原布局和 owner。
  // 来源和工作树目标共用此投影边界；实际人工输入接管生命周期，保护已编辑发布配置/计划。
  return context
    ? host
      ? createPortal(
          <div
            className="min-w-0"
            onPointerDownCapture={context.onInteraction}
            onKeyDownCapture={context.onInteraction}
            onChangeCapture={context.onInteraction}
          >
            {children}
          </div>,
          host.element,
        )
      : null
    : children;
}
