import { useState } from "react";
import type { GitIntegrationMode } from "@lcode/shared";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useGitIntegration } from "@/hooks/useGitIntegration.js";
import type { GitOperationScope } from "@/hooks/useGitOperationSession.js";
import { GitOperationResult } from "./GitOperationResult.js";
import { GitOperationRecovery } from "./GitOperationRecovery.js";

export function GitIntegrationPane({
  onResolveConflicts,
  ...props
}: GitOperationScope & { onResolveConflicts?: () => void }) {
  const integration = useGitIntegration(props),
    { session, snapshot, confirmation } = integration;
  const { intl } = useLCodeIntl(),
    t = (key: string) => intl.formatMessage({ id: `git.integration.${key}` });
  const [mode, setMode] = useState<GitIntegrationMode>("merge"),
    [target, setTarget] = useState("");
  const [nativeChecked, setNativeChecked] = useState(false),
    [discardChecked, setDiscardChecked] = useState(false);
  const enabled = session.ready && !session.pending && Boolean(snapshot);
  const operation = snapshot?.operation ?? session.receipt;
  const prepare = (kind: "continue" | "abort") => {
    setNativeChecked(false);
    setDiscardChecked(false);
    void integration.prepareAction(kind);
  };
  const active = Boolean(snapshot?.operation && !snapshot.operation.resolved);
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col bg-background text-ui-sm text-foreground"
      data-testid="git-integration-pane"
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="flex-1 font-medium">{t("title")}</span>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t("refresh")}
          title={t("refresh")}
          disabled={!session.ready || session.pending}
          onClick={() => {
            void integration.refresh();
            void session.loadReceipt();
          }}
        >
          <RefreshCw className={session.pending ? "size-3.5 animate-spin" : "size-3.5"} />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="space-y-1 border-b border-border px-3 py-2 text-ui-xs text-foreground-subtle">
          <p className="break-all">{snapshot?.root ?? props.workspacePath}</p>
          <p>
            {t("branch")}: <span className="text-foreground">{snapshot?.branch ?? "—"}</span> ·{" "}
            <span className="font-mono">{snapshot?.head?.slice(0, 12) ?? "—"}</span>
          </p>
        </div>
        {!active ? (
          <div className="space-y-2 border-b border-border px-3 py-2">
            <label className="flex items-center gap-2">
              {t("mode")}
              <select
                className="h-8 min-w-0 flex-1 rounded border border-input-border bg-input px-2 text-mobile-input-safe md:text-ui-sm"
                aria-label={t("mode")}
                value={mode}
                disabled={!enabled || snapshot?.blocked || Boolean(snapshot?.nativeMode)}
                onChange={(event) => {
                  setMode(event.target.value as GitIntegrationMode);
                  integration.cancel();
                }}
              >
                <option value="merge">Merge</option>
                <option value="rebase">Rebase</option>
                <option value="cherry-pick">Cherry-pick</option>
                <option value="revert">Revert</option>
              </select>
            </label>
            <label className="block space-y-1">
              <span>{t("target")}</span>
              <Input
                className="text-mobile-input-safe md:text-ui-sm"
                aria-label={t("target")}
                data-testid="git-integration-target"
                value={target}
                placeholder="refs/heads/main"
                maxLength={1024}
                disabled={!enabled || snapshot?.blocked || Boolean(snapshot?.nativeMode)}
                onChange={(event) => {
                  setTarget(event.target.value);
                  integration.cancel();
                }}
              />
            </label>
            <select
              aria-label={t("chooseBranch")}
              className="h-8 w-full min-w-0 rounded border border-input-border bg-input px-2 text-mobile-input-safe md:text-ui-sm"
              value={integration.refs.includes(target) ? target : ""}
              disabled={!enabled || snapshot?.blocked || Boolean(snapshot?.nativeMode)}
              onChange={(event) => {
                setTarget(event.target.value);
                integration.cancel();
              }}
            >
              <option value="">{t("chooseBranch")}</option>
              {integration.refs.map((ref) => (
                <option key={ref} value={ref}>
                  {ref}
                </option>
              ))}
            </select>
            <p className="text-ui-xs text-foreground-subtle">{t(`${mode}Hint`)}</p>
          </div>
        ) : (
          <div
            className="space-y-1 border-b border-border px-3 py-2 text-ui-xs"
            data-testid="git-integration-active"
          >
            <p className="font-medium">
              {snapshot?.operation?.integration?.mode.toUpperCase()} ·{" "}
              {snapshot?.operation?.integration?.branch}
            </p>
            <p className="break-all font-mono">
              {snapshot?.operation?.integration?.head.slice(0, 12)} →{" "}
              {snapshot?.operation?.integration?.target.slice(0, 12)}
            </p>
            {snapshot?.progress ? (
              <p>
                {t("progress")}: {snapshot.progress}
              </p>
            ) : null}
            <p className="text-foreground-subtle">{t("pauseHint")}</p>
          </div>
        )}
        {snapshot?.blocked ? (
          <p className="px-3 py-2 text-ui-xs text-warning" role="status">
            {t("reserved")}
          </p>
        ) : null}
        {snapshot?.nativeMode && !active ? (
          <p className="px-3 py-2 text-ui-xs text-warning">{t("external")}</p>
        ) : null}
        <GitOperationResult receipt={session.receipt ?? operation} error={session.error} />
        {snapshot?.conflicts.length ? (
          <div className="space-y-2 border-b border-border px-3 py-2">
            <p>
              {t("conflicts")} · {snapshot.conflicts.length}
            </p>
            <Button
              size="sm"
              variant="outline"
              data-testid="git-integration-resolve"
              onClick={onResolveConflicts}
            >
              {t("resolve")}
            </Button>
          </div>
        ) : null}
        {snapshot?.changedFiles.length ? (
          <details open className="border-b border-border px-3 py-2">
            <summary className="cursor-pointer text-ui-xs">
              {t("changes")} · {snapshot.changedFiles.length}
            </summary>
            <ul className="max-h-48 overflow-auto py-1 font-mono text-ui-xs">
              {snapshot.changedFiles.map((path) => (
                <li className="break-all py-0.5" key={path}>
                  {path}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {confirmation ? (
          <section
            className="space-y-2 border-b border-border bg-surface px-3 py-3"
            data-testid="git-integration-confirmation"
          >
            <p className="font-medium">{t(confirmation.kind)}</p>
            {confirmation.kind === "start" ? (
              <>
                <p className="break-all text-ui-xs">
                  {confirmation.preview.root} · {confirmation.preview.branch}
                </p>
                <p className="break-all font-mono text-ui-xs">
                  {confirmation.preview.head} → {confirmation.preview.target}
                </p>
                <p className="break-all text-ui-xs">{confirmation.preview.targetRef}</p>
                <p className="text-ui-xs text-foreground-subtle">
                  {confirmation.preview.mode === "rebase"
                    ? `${t("rewrite")}: ${confirmation.preview.commitCount}`
                    : t(`${confirmation.preview.mode}Hint`)}
                </p>
              </>
            ) : (
              <>
                <p className="break-all text-ui-xs">{confirmation.snapshot.root}</p>
                <p className="break-all font-mono text-ui-xs">{confirmation.snapshot.head}</p>
                {confirmation.kind === "abort" ? (
                  <label className="flex items-start gap-2 text-ui-xs text-destructive">
                    <input
                      className="mt-0.5 size-3.5 shrink-0"
                      type="checkbox"
                      data-testid="git-integration-discard-check"
                      checked={discardChecked}
                      onChange={(event) => setDiscardChecked(event.target.checked)}
                    />
                    {t("abortWarning")}
                  </label>
                ) : (
                  <p className="text-ui-xs">{t("continueHint")}</p>
                )}
                {confirmation.snapshot.needsNativeConfirmation ? (
                  <label className="flex items-start gap-2 text-ui-xs">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-3.5 shrink-0"
                      checked={nativeChecked}
                      onChange={(event) => setNativeChecked(event.target.checked)}
                    />
                    {intl.formatMessage({ id: "git.workspace.confirmNativeStopped" })}
                  </label>
                ) : null}
              </>
            )}
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={session.pending}
                onClick={integration.cancel}
              >
                {intl.formatMessage({ id: "common.cancel" })}
              </Button>
              <Button
                size="sm"
                variant={confirmation.kind === "abort" ? "destructive" : "default"}
                data-testid="git-integration-confirm"
                disabled={
                  !enabled ||
                  (confirmation.kind !== "start" &&
                    ((confirmation.kind === "abort" && !discardChecked) ||
                      (confirmation.snapshot.needsNativeConfirmation && !nativeChecked) ||
                      !(confirmation.kind === "abort"
                        ? confirmation.snapshot.canAbort
                        : confirmation.snapshot.canContinue)))
                }
                onClick={() => {
                  void integration.confirm(nativeChecked, discardChecked);
                }}
              >
                {t("confirm")}
              </Button>
            </div>
          </section>
        ) : null}
        {!snapshot?.canAbort && !snapshot?.canContinue ? (
          <GitOperationRecovery
            session={session}
            operation={operation}
            onComplete={integration.refresh}
          />
        ) : null}
      </div>
      <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border bg-panel px-3 py-2">
        {active ? (
          <>
            <Button
              size="sm"
              variant="outline"
              data-testid="git-integration-abort"
              disabled={!enabled || !snapshot?.canAbort}
              onClick={() => prepare("abort")}
            >
              {t("abort")}
            </Button>
            <Button
              size="sm"
              data-testid="git-integration-continue"
              disabled={!enabled || !snapshot?.canContinue}
              onClick={() => prepare("continue")}
            >
              {t("continue")}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            data-testid="git-integration-start"
            disabled={!enabled || !target || snapshot?.blocked || Boolean(snapshot?.nativeMode)}
            onClick={() => {
              void integration.prepareStart(mode, target);
            }}
          >
            {t("preview")}{" "}
            {mode === "cherry-pick"
              ? "Cherry-pick"
              : mode === "revert"
                ? "Revert"
                : mode === "merge"
                  ? "Merge"
                  : "Rebase"}
          </Button>
        )}
      </footer>
    </section>
  );
}
