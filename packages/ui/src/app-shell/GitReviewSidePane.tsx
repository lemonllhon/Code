import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import {
  commitReviewNavigationKey,
  useCommitReviewNavigationStore,
  type GitWorkbenchView,
} from "@/store/commitReviewNavigationStore.js";
import { GitHistoryPane } from "@/git-graph/GitHistoryPane.js";
import { GitNetworkPane } from "@/git-network/GitNetworkPane.js";
import { GitStashPane } from "@/git-workspace/GitStashPane.js";
import { GitConflictsPane } from "@/git-conflicts/GitConflictsPane.js";
import { GitIntegrationPane } from "@/git-workspace/GitIntegrationPane.js";
import { useOwnerDocument } from "@/components/ui/owner-document.js";

export function GitReviewSidePane({
  workspaceKey,
  sessionId,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  visible,
  view,
  children,
  onRefresh,
  onSelectView,
}: {
  workspaceKey: string;
  sessionId: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  visible: boolean;
  view: GitWorkbenchView;
  children: ReactNode;
  onRefresh?: () => void;
  onSelectView?: (view: GitWorkbenchView) => void;
}) {
  const { intl } = useLCodeIntl();
  const host = useRef<HTMLDivElement>(null);
  const ownerDocument = useOwnerDocument();
  const key = commitReviewNavigationKey(workspaceKey, undefined, sessionId ?? "");
  const token = useMemo(() => crypto.randomUUID(), [key]);
  useEffect(() => {
    const store = useCommitReviewNavigationStore.getState();
    return () => store.removePaneHost(key, token);
  }, [key, token]);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    // 更新插槽不能先注销，否则切 document 时会误释放仍在使用的审核控制器。
    useCommitReviewNavigationStore.getState().registerPaneHost(key, {
      token,
      element,
      visible: visible && view === "review",
      selectView: onSelectView,
      onRefresh,
    });
  }, [key, token, visible, view, ownerDocument, onSelectView, onRefresh]);
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col bg-background"
      data-testid="git-review-side-pane"
    >
      <nav
        className="flex h-9 min-w-0 shrink-0 gap-3 overflow-x-auto border-b border-border px-3"
        aria-label="Git"
      >
        {(
          ["review", "changes", "graph", "network", "stash", "integration", "conflicts"] as const
        ).map((item) => (
          <Button
            key={item}
            type="button"
            variant="ghost"
            size="sm"
            aria-current={view === item ? "page" : undefined}
            className={
              view === item
                ? "h-full rounded-none border-b-2 border-b-primary px-0 text-ui-sm text-foreground hover:bg-transparent"
                : "h-full rounded-none px-0 text-ui-sm text-foreground-subtle hover:bg-transparent"
            }
            data-testid={`git-view-${item}`}
            onClick={() => {
              const store = useCommitReviewNavigationStore.getState();
              store.selectPaneView(key, item);
              if (item === "review") store.open(key);
            }}
          >
            {intl.formatMessage({
              id:
                item === "review"
                  ? "git.commitWorkflow.local.title"
                  : item === "changes"
                    ? "git.review.changesView"
                    : item === "graph"
                      ? "gitGraph.title"
                      : item === "network"
                        ? "git.network.title"
                        : item === "stash"
                          ? "git.workspace.stashTitle"
                          : item === "integration"
                            ? "git.integration.title"
                            : "git.conflict.title",
            })}
          </Button>
        ))}
      </nav>
      <div
        ref={host}
        className={
          view === "review"
            ? "relative min-h-0 flex-1 [&:has(>[data-review-visible=true])>[data-review-empty]]:hidden"
            : "hidden"
        }
        data-testid="git-review-pane-host"
      >
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-ui-sm text-foreground-subtle"
          data-testid="git-review-empty"
          data-review-empty=""
        >
          <p>{intl.formatMessage({ id: "git.review.openHint" })}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => useCommitReviewNavigationStore.getState().open(key)}
          >
            {intl.formatMessage({ id: "git.commitWorkflow.local.title" })}
          </Button>
        </div>
      </div>
      <div className={view === "changes" ? "min-h-0 flex-1" : "hidden"}>{children}</div>
      {view === "stash" ? (
        <div className="min-h-0 flex-1">
          <GitStashPane
            key={JSON.stringify([workspacePath, workspaceIdentity, workspaceRemoteSessionId])}
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            workspaceRemoteSessionId={workspaceRemoteSessionId}
            onRefresh={onRefresh}
            onResolveConflicts={() =>
              useCommitReviewNavigationStore.getState().selectPaneView(key, "conflicts")
            }
          />
        </div>
      ) : null}
      {view === "network" ? (
        <div className="min-h-0 flex-1">
          <GitNetworkPane
            key={JSON.stringify([workspacePath, workspaceIdentity, workspaceRemoteSessionId])}
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            workspaceRemoteSessionId={workspaceRemoteSessionId}
            onRefresh={onRefresh}
            publicationScope={key}
            visible={visible}
          />
        </div>
      ) : null}
      {view === "conflicts" ? (
        <div className="min-h-0 flex-1">
          <GitConflictsPane
            key={JSON.stringify([workspacePath, workspaceIdentity, workspaceRemoteSessionId])}
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            workspaceRemoteSessionId={workspaceRemoteSessionId}
            onRefresh={onRefresh}
            onIntegrate={() =>
              useCommitReviewNavigationStore.getState().selectPaneView(key, "integration")
            }
          />
        </div>
      ) : null}
      {view === "integration" ? (
        <div className="min-h-0 flex-1">
          <GitIntegrationPane
            key={JSON.stringify([workspacePath, workspaceIdentity, workspaceRemoteSessionId])}
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            workspaceRemoteSessionId={workspaceRemoteSessionId}
            onRefresh={onRefresh}
            onResolveConflicts={() =>
              useCommitReviewNavigationStore.getState().selectPaneView(key, "conflicts")
            }
          />
        </div>
      ) : null}
      {view === "graph" ? (
        <div className="min-h-0 flex-1">
          <GitHistoryPane
            key={JSON.stringify([workspacePath, workspaceIdentity, workspaceRemoteSessionId])}
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            workspaceRemoteSessionId={workspaceRemoteSessionId}
            onIntegrate={() =>
              useCommitReviewNavigationStore.getState().selectPaneView(key, "integration")
            }
            onRefresh={onRefresh}
          />
        </div>
      ) : null}
    </section>
  );
}
