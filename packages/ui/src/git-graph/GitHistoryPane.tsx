import { useState } from "react";
import { Group } from "react-resizable-panels";
import { Button } from "@/components/ui/button.js";
import { ResizableHandle, ResizablePanel } from "@/components/ui/resizable.js";
import { useGitHistory } from "@/hooks/useGitHistory.js";
import type { GitOperationScope } from "@/hooks/useGitOperationSession.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { GitOperationResult } from "@/git-workspace/GitOperationResult.js";
import { GitGraphPane } from "./GitGraphPane.js";
import { GitHistoryDetail } from "./GitHistoryDetail.js";
import { GitHistoryConfirmation } from "./GitHistoryConfirmation.js";
import { GitOperationRecovery } from "@/git-workspace/GitOperationRecovery.js";
import { GitHistoryToolbar } from "./GitHistoryToolbar.js";

export function GitHistoryPane(props: GitOperationScope & { onIntegrate: () => void }) {
  const history = useGitHistory(props);
  const { session, page, detail } = history;
  const { intl } = useLCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `git.history.${key}` });
  const [detailOpen, setDetailOpen] = useState(true);
  const [panelRequest, setPanelRequest] = useState<{
    hash: string;
    sequence: number;
    kind: "tag" | "reset";
  }>();
  const showDetail = Boolean(detail && detailOpen);
  const enabled = session.ready && !session.pending;
  const [selection, setSelection] = useState({
    context: session.context,
    filters: history.filters,
    values: [] as string[],
  });
  const marked =
    selection.context === session.context && selection.filters === history.filters
      ? selection.values
      : [];
  const toggle = (hash: string) => {
    history.cancel();
    setSelection({
      context: session.context,
      filters: history.filters,
      values: marked.includes(hash)
        ? marked.filter((item) => item !== hash)
        : marked.length < 32
          ? [...marked, hash]
          : marked,
    });
  };
  const prepareBatch = (mode: "cherry-pick" | "revert") => {
    let targets = (page?.commits ?? [])
      .filter((item) => marked.includes(item.hash))
      .map((item) => item.hash);
    if (mode === "cherry-pick") targets = targets.reverse();
    if (targets.length) void history.prepareAction(mode, targets[0], undefined, targets);
  };
  return (
    <section
      className="@container/history flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background text-ui-sm text-foreground"
      data-testid="git-history-pane"
    >
      <GitHistoryToolbar
        history={history}
        detailHidden={Boolean(detail && !detailOpen)}
        onShowDetail={() => setDetailOpen(true)}
      />
      {marked.length ? (
        <div
          className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1 text-ui-xs"
          data-testid="git-history-selection"
        >
          <span className="mr-auto">
            {intl.formatMessage({ id: "git.history.selectedCount" }, { count: marked.length })}
          </span>
          {(["cherry-pick", "revert"] as const).map((mode) => (
            <Button
              key={mode}
              size="sm"
              variant="ghost"
              disabled={
                !enabled ||
                (page?.commits.some(
                  (commit) => marked.includes(commit.hash) && commit.parents.length > 1,
                ) ??
                  false)
              }
              onClick={() => prepareBatch(mode)}
            >
              {mode === "cherry-pick" ? "Cherry-pick" : "Revert"}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            disabled={!enabled}
            onClick={() =>
              setSelection({ context: session.context, filters: history.filters, values: [] })
            }
          >
            {t("clearSelection")}
          </Button>
        </div>
      ) : null}
      {session.receipt || session.error ? (
        <div className="max-h-28 shrink-0 overflow-auto">
          <GitOperationResult receipt={session.receipt} error={session.error} />
          {session.receipt?.historyReset ? (
            <div className="space-y-1 px-3 py-2">
              <p className="break-all font-mono text-ui-xs">
                {session.receipt.historyReset.backupRef}
                {session.receipt.historyReset.stashRef
                  ? ` · ${session.receipt.historyReset.stashRef}`
                  : ""}
              </p>
              {session.receipt.kind === "history-reset" && session.receipt.status === "success" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!enabled}
                  onClick={() => {
                    void history.prepareResetRecovery();
                  }}
                >
                  {t("restoreReset")}
                </Button>
              ) : null}
            </div>
          ) : null}
          <GitOperationRecovery
            session={session}
            operation={session.receipt}
            onComplete={() => {
              void history.refresh(history.filters);
            }}
          />
          {session.receipt?.kind === "history-tag" && session.receipt.tagName ? (
            <div className="border-b border-border px-3 py-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!enabled}
                data-testid="git-history-tag-inspect"
                onClick={() => {
                  void history.inspectTag(session.receipt!.tagName!);
                }}
              >
                {t("inspectTag")}
              </Button>
              {history.tagInfo ? (
                <p
                  className="mt-1 break-all font-mono text-ui-xs"
                  data-testid="git-history-tag-info"
                >
                  {history.tagInfo.name} · {history.tagInfo.oid ?? "—"} →{" "}
                  {history.tagInfo.target ?? "—"} ·{" "}
                  {history.tagInfo.hasSignature ? t("signaturePresent") : t("noSignature")}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <Group
          orientation="vertical"
          className="h-full min-h-0 min-w-0"
          resizeTargetMinimumSize={{ coarse: 20, fine: 10 }}
        >
          <ResizablePanel
            id="git-history-graph-panel"
            defaultSize={showDetail ? "55%" : "100%"}
            minSize="20%"
          >
            <div className="h-full min-h-0 min-w-0" data-testid="git-history-graph">
              <GitGraphPane
                compact
                showInlineDetail={false}
                disabled={!enabled}
                commits={page?.commits ?? []}
                marked={marked}
                onToggleCommit={toggle}
                selectedCommitHash={detail?.hash ?? null}
                hasMore={page?.hasMore}
                loadingMore={session.pending}
                commitTestId="git-history-commit"
                loadMoreTestId="git-history-more"
                limitReached={Boolean(page && page.commits.length > 10000)}
                onSelectCommit={(hash) => {
                  setPanelRequest(undefined);
                  setDetailOpen(true);
                  void history.select(hash);
                }}
                onCommitAction={(hash, action) => {
                  setDetailOpen(true);
                  setPanelRequest(
                    action === "tag" || action === "reset"
                      ? { hash, kind: action, sequence: Date.now() }
                      : undefined,
                  );
                  if (action === "view" || action === "tag" || action === "reset")
                    void history.select(hash);
                  else void history.prepareAction(action, hash);
                }}
                onLoadMore={() => {
                  if (enabled) void history.more();
                }}
              />
            </div>
          </ResizablePanel>
          {showDetail ? (
            <>
              <ResizableHandle
                aria-label={t("resizeHistory")}
                className="!m-0 !h-1.5 !w-full !translate-y-0 border-y border-border ![mask-image:none]"
              />
              <ResizablePanel id="git-history-details" defaultSize="45%" minSize="25%">
                <GitHistoryDetail
                  key={JSON.stringify([session.context.request, detail?.hash])}
                  history={history}
                  panelRequest={panelRequest}
                  onClose={() => {
                    history.cancel();
                    setDetailOpen(false);
                  }}
                />
              </ResizablePanel>
            </>
          ) : null}
        </Group>
      </div>
      <GitHistoryConfirmation history={history} />
    </section>
  );
}
